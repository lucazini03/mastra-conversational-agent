# MemorAIz — Voice Agent

---

## Indice

1. [Cos’è](#1-cosè)
2. [Architettura ad alto livello](#2-architettura-ad-alto-livello)
3. [La personalità del Professore in dettaglio](#3-la-personalità-del-professore-in-dettaglio)
4. [Perché e come pre-sintetizziamo il documento (topic-seeding RAG)](#4-perché-e-come-pre-sintetizziamo-il-documento-topic-seeding-rag)
5. [RAG in tempo reale durante la conversazione](#5-rag-in-tempo-reale-durante-la-conversazione)
6. [Voice Activity Detection (VAD) — perché e come](#6-voice-activity-detection-vad--perché-e-come)
7. [Ciclo dei token via WebSocket — perché e come](#7-ciclo-dei-token-via-websocket--perché-e-come)
8. [Ripresa della sessione (disconnessioni inattese)](#8-ripresa-della-sessione-disconnessioni-inattese)
9. [Tracciamento dei costi](#9-tracciamento-dei-costi)
10. [Logging delle sessioni](#10-logging-delle-sessioni)
11. [Altre personalità assistant](#11-altre-personalità-assistant)
12. [Avvio del progetto](#12-avvio-del-progetto)
13. [Struttura del repository](#13-struttura-del-repository)

---

## 1. Cos’è

Questo progetto contiene l'implementazione di una **voce AI real-time** che simula un esame orale universitario per studenti H-Farm (ma può essere adattato ad altri contesti, tramite il system context). Uno studente apre il browser, carica una trascrizione della lezione (o un qualunque documento di studio) e si trova subito davanti a un professore che parla, ascolta e interroga. Il professore:

- parla con un tono accademico naturale in italiano usando la Gemini Live API di Google
- segue un programma strutturato ricavato dal documento caricato,
- fa domande, dà feedback in una riga, traccia la padronanza per sottotema,
- assegna un voto finale quando tutti gli argomenti sono stati coperti.

Oltre al professore, lo stesso runtime ospita altre cinque personalità assistant (interview coach, study tutor, audio guide, immigration assistant, language tutor), tutte basate sulla stessa infrastruttura.

---

## 2. Architettura ad alto livello

```text
Browser (public/)
   │  Silero VAD (ONNX/WASM)
   │  Acquisizione WebAudio PCM (16 kHz, 16-bit, mono)
   │  Riproduzione WebAudio (24 kHz, 16-bit, mono)
   │
   │  WebSocket (frame JSON di controllo + chunk PCM base64)
   │
Node.js Server (src/server/index.ts)  <── Express HTTP (serve public/)
   │
   ├── SessionHandler (una istanza per ogni connessione WS del browser)
   │     ├── DocumentService      – parsing PDF/TXT, generazione sintesi topic via LLM
   │     ├── BrowserRagService    – vector store DuckDB, ricerca semantica
   │     ├── ContextManager       – monitoraggio token, compaction, scheduling switch WS
   │     ├── SessionCostTracker   – accounting token/costi
   │     └── SessionLogger        – file .log + .json per sessione
   │
   └── createProfessorAgent()     – GeminiLiveVoice + Mastra Agent per sessione
            │
            │  WebSocket bidirezionale (Google BidiGenerateContent)
            │
         Google Gemini Live API
            ├── Speech-to-text (audio utente → trascrizione)
            ├── LLM reasoning + tool calls
            └── Text-to-speech (testo modello → audio)
```

Ogni connessione browser riceve una propria istanza isolata di `SessionHandler`. **Non esiste stato condiviso tra utenti.** Il server è stateless e può scalare orizzontalmente senza problemi. Tutto lo stato specifico della sessione (stato del professore, documenti caricati, log) è salvato su disco in modo persistente e isolato per sessione.

---

## 3. La personalità del Professore in dettaglio

### Due modalità

| Modalità | Quando si attiva | Comportamento |
|----------|------------------|---------------|
| **RAG** | È stato caricato un documento di supporto/riassunto | Il syllabus viene estratto all’inizio; `search_documents` viene usato per ogni sottotema |
| **Free Roam** | Nessun documento caricato | Il professore improvvisa sul tema scelto dallo studente; i concetti vengono scoperti al volo |

### Flusso dell’esame (modalità RAG)

1. **Fase 1 – Apertura.** Il professore si presenta come "l'assistente del professore di [materia] per il college H-Farm", deduce la materia dal syllabus e chiede il nome dello studente.
2. **Fase 2 – Scelta degli argomenti.** Elenca i macro-argomenti ancora con mastery score 0. Lo studente (o il professore) sceglie da dove iniziare.
3. **Fase 3 – Ciclo d’esame.** Per ogni sottotema:
    - chiama `search_documents` con il nome del sottotema per recuperare contenuto grounded dal RAG index,
    - formula una domanda **solo** a partire dal testo recuperato,
    - dà feedback: "Corretto" / "Quasi" / "Non proprio" + una correzione in una riga se serve,
    - aggiorna il mastery score del sottotema (0–3) nello stato compatto.
4. **Fase 4 – Voto finale.** Quando tutti i sottotemi sono a mastery ≥ 2 (o lo studente chiede il voto), il professore assegna un punteggio con motivazione.

### Scoring di mastery

| Score | Significato |
|------|------------|
| 0 | Non ancora discusso |
| 1 | Lacune importanti — il professore ha dovuto spiegare |
| 2 | Sufficiente — lo studente ha risposto con aiuti |
| 3 | Forte — risposta corretta senza aiuto |

---

## 4. Perché e come pre-sintetizziamo il documento (topic-seeding RAG)

### Il problema delle allucinazioni

Senza pre-processing, l’unico modo per il professore di sapere quali argomenti esistono nel documento caricato sarebbe cercarli runtime. Ma questo crea un problema circolare: per cercare un topic, devi già sapere cosa cercare.

Una soluzione ingenua sarebbe chiamare `search_documents("next topic to discuss")` o `search_documents("main subjects in the document")`. In pratica fallisce perché:

- il vector store fa **cosine similarity** tra l’embedding della query e quelli dei chunk; query vaghe come "next topic" matchano male con testo accademico denso,
- il professore recupererebbe chunk irrilevanti e allucinerebbe topic inesistenti oppure perderebbe capitoli presenti nel documento.

### La soluzione: una sola chiamata LLM all’inizio della sessione

Quando lo studente carica un documento, **prima** che la WebSocket Gemini Live venga aperta, `DocumentService.getOrGenerateSummary()` fa questo:

```text
1. Parsing del file caricato (PDF o TXT) → testo normalizzato
2. Calcolo dell’hash SHA-256 del testo combinato
3. Controllo di logs/summaries/<hash>_summary.json su disco  (cache)
    CACHE HIT  → carica il JSON istantaneamente, costo LLM zero
    CACHE MISS → chiama gemini-3.1-flash-lite-preview con il testo completo
                        prompt: "Estrai un indice dettagliato dei topic. Restituisci solo
                                     gli argomenti esplicitamente presenti nel testo sorgente."
                        output: { main_topics: [ { topic, subtopics: [...] } ] }
                        salva su disco per future sessioni con lo stesso documento
```

Il modello usato è volutamente **piccolo ed economico** (Gemini Flash Lite). Non deve ragionare: deve solo estrarre una lista strutturata da un testo che può leggere interamente. È molto veloce. Il risultato è un syllabus dettagliato che il professore può usare per guidare la conversazione in modo affidabile, senza allucinazioni.

#### Contesto: come otteniamo il documento a H-Farm

A H-Farm, la lezione viene già caricata dal docente come videolezione. Il sistema esegue automaticamente la trascrizione tramite **STT**. Inoltre, abbiamo già un riassunto della lezione, anche se non strutturato. L'idea è: prima, facciamo un ulteriore riassunto strutturato (topic-seeding) con un LLM, e poi usiamo quel riassunto per alimentare il professore. Il documento di supporto per il RAG è la trascrizione completa.

#### Esempio concreto

Immaginiamo che uno studente carichi la trascrizione di una lezione sulla Guerra Fredda. Il testo contiene sezioni sul Piano Marshall, il Muro di Berlino, la NATO e la Space Race.

L’LLM produce:

```json
{
   "main_topics": [
      {
         "topic": "The Marshall Plan",
         "subtopics": ["Origins and US motives", "European reconstruction funds", "Soviet rejection"]
      },
      {
         "topic": "The Berlin Wall",
         "subtopics": ["Construction in 1961", "Life in divided Berlin", "Fall in 1989"]
      },
      {
         "topic": "NATO formation",
         "subtopics": ["Founding treaty 1949", "Article 5 collective defence"]
      },
      {
         "topic": "The Space Race",
         "subtopics": ["Sputnik launch", "Apollo programme", "Technological propaganda"]
      }
   ]
}
```

Questo JSON viene poi convertito in una checklist markdown compatta e aggiunto al system prompt del professore **prima** che la connessione Gemini Live venga aperta:

```markdown
## SESSION STATE (RAG Mode)
**Student:** (non fornito)
### Topics to Cover
**The Marshall Plan**
- [ ] Origins and US motives
- [ ] European reconstruction funds
- [ ] Soviet rejection
**The Berlin Wall**
- [ ] Construction in 1961
- [ ] Life in divided Berlin
- [ ] Fall in 1989
...
```

Il professore conosce così il syllabus completo fin dal primo messaggio. Quando chiede "Construction in 1961" chiama `search_documents("Construction in 1961")`, una query specifica e grounded che recupera in modo affidabile il passaggio rilevante dall’indice vettoriale.

**Nessuna allucinazione. Nessuna ricerca vaga. Latenza extra zero per gli utenti già noti (cache hit).**

### I due campi di upload dei documenti

La UI del browser espone due aree di upload distinte:

| Campo | Scopo |
|------|-------|
| **Documento base** (fonte del riassunto) | Usato **solo** per l’estrazione one-off dei topic tramite LLM. Tipicamente la trascrizione completa della lezione. |
| **Documenti di supporto** (fonte RAG) | Chunked, embedded e salvati nell’indice vettoriale DuckDB. Interrogati runtime da `search_documents`. |

Se viene caricato solo il documento base, esso viene riusato per entrambi gli scopi. Se vengono caricati solo documenti di supporto, lo step di estrazione dei topic viene saltato.

---

## 5. RAG in tempo reale durante la conversazione

La pipeline RAG (`src/server/ragService.ts`) gira in parallelo alla sessione Live:

1. **Costruzione dell’indice** (una volta per sessione, asincrona, in background mentre la WS si connette):
    - ogni documento di supporto caricato viene parsato in testo normale,
    - il testo viene chunked (default: chunk da 1200 caratteri, overlap di 200 caratteri),
    - ogni chunk viene embeddato usando `gemini-embedding-001` (tramite Google AI SDK),
    - embedding + metadata vengono upsertati in un vector store **DuckDB** su disco (`rag.duckdb`),
    - ogni sessione usa il proprio nome indice (`pdf_knowledge_<sessionId>`) così più utenti non collidono.

2. **Tool `search_documents`** (registrato sul Mastra Agent):
    - viene chiamato dal professore quando deve formulare una domanda su uno specifico sottotema,
    - il testo della query viene embeddato, parte la ricerca per cosine similarity e vengono restituiti i top-K chunk,
    - i chunk sotto una soglia minima di similarità vengono scartati (default: 0.1),
    - il testo restituito viene iniettato nel contesto del professore come grounding per la domanda successiva.

Il prompt del professore istruisce esplicitamente: *"Chiama `search_documents` il meno possibile — solo per nuovi sottotemi non ancora presenti nel contesto."* Questo evita chiamate API ridondanti una volta che un passaggio è già stato recuperato.

---

## 6. Voice Activity Detection (VAD) — perché e come

### Perché usare il VAD?

La Gemini Live API di Google fattura **per secondo di audio trasmesso**, indipendentemente dal fatto che l’utente stia parlando o sia in silenzio. In una sessione tipica con pause tra le risposte e i turni di parola del professore, un approccio ingenuo (streaming continuo del microfono) farebbe pagare molto più audio input del necessario.

Il VAD risolve questo problema inviando audio al server **solo quando l’utente sta effettivamente parlando**.

### Come funziona (VAD a due livelli)

**Livello 1 — Silero VAD (browser, locale, zero costo):**

`@ricky0123/vad-web` esegue il modello Silero VAD ONNX dentro un worker WebAssembly nel browser. Elabora continuamente frame grezzi del microfono con costo computazionale minimo.

- `positiveSpeechThreshold: 0.9` — attiva solo su speech ad alta confidenza (riduce falsi positivi da tastiera, rumore, voci di sottofondo),
- `negativeSpeechThreshold: 0.4` — disattiva quando la confidenza scende sotto 0.4 (permette pause naturali dentro una frase senza interrompere),
- `minSpeechMs: 180` — ignora burst più brevi di 180 ms (tosse, click),
- `preSpeechPadMs: 160` + buffer preroll server-side (280 ms) — evita di tagliare la prima sillaba quando il rilevamento arriva leggermente in ritardo.

Quando Silero emette `onSpeechRealStart`:
1. tutta la riproduzione TTS viene fermata immediatamente (lo studente ha interrotto il professore),
2. `{ type: 'activity_start' }` viene inviato via WebSocket e inoltrato a Gemini come `realtimeInput.activityStart`,
3. il preroll buffer (gli ultimi 280 ms di frame audio catturati mentre il VAD era inattivo) viene svuotato verso il server,
4. i frame audio successivi vengono trasmessi come `{ type: 'audio_chunk', data: <base64 PCM> }`.

Quando Silero emette `onSpeechEnd`:
1. `{ type: 'activity_end' }` viene inviato e inoltrato a Gemini come `realtimeInput.activityEnd`,
2. lo streaming del microfono si ferma,
3. il preroll buffer viene svuotato.

**Livello 2 — VAD server-side di Gemini (disabilitato nel nostro setup):**

La Gemini Live API ha un VAD integrato. Noi lo **disabilitiamo** tramite un evento `setup` patchato (in `agentFactory.ts`), perché:
- il nostro Silero VAD è più reattivo (gira localmente, senza latenza di rete),
- il VAD server-side farebbe pagare due volte l’audio input, visto che stiamo già eseguendo un gating intelligente sul client,
- disattivarlo ci dà controllo preciso sui segnali `activityStart`/`activityEnd`.

### Risultato

Una sessione tipica di 15 minuti genera circa 3–4 minuti di parlato reale dello studente (il resto è il professore, pause e tempo di riflessione). Senza VAD, avremmo 15 minuti di audio input fatturato, con VAD paghiamo solo per i minuti effettivi di parlato dello studente, riducendo significativamente i costi.

---

## 7. Ciclo dei token via WebSocket — perché e come

### Il problema dei costi quadratici

La Gemini Live API mantiene un contesto conversazionale nativo. Ogni turno della conversazione costa token proporzionalmente alla **cronologia accumulata**. Il turno 1 costa 1x, il turno 50 costa molto più del turno 1. In una sessione lunga il costo per turno cresce linearmente, quindi il costo totale cresce in modo **quadratico**.

Per un esame da 30 minuti con molti scambi domanda/risposta, questo diventa costoso. Serve un modo per resettare periodicamente il contatore dei token senza perdere continuità conversazionale.

### La soluzione: Memoria Osservazionale + ciclazione del WebSocket

`ContextManager` (`src/services/contextManager/contextManager.ts`) implementa questo processo in più passaggi.

#### Passo 1 — Monitoraggio token

Dopo ogni messaggio Gemini, il server legge il campo `usageMetadata` dal frame WebSocket raw e accumula i token `inputText + inputAudio`. `ContextManager.checkTokenThreshold()` viene chiamato con lo snapshot più recente. Quando:

```text
(currentTotalInput - lastSwitchTokenCount) >= MEMORY_EXTRACTION_TOKEN_THRESHOLD
```

il manager imposta un flag: "estrai al prossimo `turnComplete`". La soglia di default è **50.000 token** (configurabile via `MEMORY_EXTRACTION_TOKEN_THRESHOLD`).

#### Passo 2 — Estrazione (alla successiva silenzio naturale)

`turnComplete` è il segnale che Gemini invia quando il modello ha finito la risposta — la pausa tra i turni. È il momento ideale per fare lavoro in background:
- il professore ha smesso di parlare,
- nessun audio viene trasmesso,
- un piccolo delay qui è invisibile all’utente.

A quel punto, `ContextManager` invia il **delta transcript** (solo i turni successivi all’ultima estrazione) a un piccolo LLM (`gemini-3.1-flash-lite-preview`, con `gemini-2.5-flash-lite` come fallback) con un prompt strutturato di estrazione:

```text
STATO ATTUALE: <JSON stato esistente>
NUOVO DELTA TRASCRIZIONE:
[model]: "Parliamo della costruzione del Muro di Berlino nel 1961..."
[user]: "Il muro è stato costruito per impedire la fuga dei cittadini della Germania Est"
[model]: "Esatto! E cosa sai delle reazioni occidentali?"

REGOLE: Aggiorna mastery_score per ogni sottotema discusso.
            Non aggiungere né rimuovere elementi da topics_to_cover.
            Aggiorna student_info, current_topic, behavioral_directives.
```

L’LLM produce uno `professorStateSchema` JSON aggiornato:

```json
{
   "session_mode": "RAG",
   "student_info": { "name": "Luca", "education_level": "university" },
   "current_topic": "The Berlin Wall",
   "topics_to_cover": [
      {
         "main_topic": "The Berlin Wall",
         "subtopics": [
            { "name": "Construction in 1961", "mastery_score": 3 },
            { "name": "Life in divided Berlin", "mastery_score": 0 },
            { "name": "Fall in 1989", "mastery_score": 0 }
         ]
      }
   ],
   "covered_concepts": [],
   "behavioral_directives": ["Lo studente preferisce domande concise"],
   "overall_evaluation": "Solida conoscenza dei fatti, analisi ancora limitata."
}
```

Questo JSON vale circa **200 token** contro un delta trascrizione che può arrivare a **5.000 token**.

#### Passo 3 — Switch del WebSocket (alla *successiva* pausa)

Quando l’estrazione è completata, il manager aspetta il **turnComplete** successivo. Questo gap di due turni garantisce che:
1. il professore finisca la frase corrente prima dello switch,
2. qualsiasi trascrizione arrivata tra l’inizio dell’estrazione e lo switch venga catturata in un “volatile buffer”.

A quel `turnComplete`, viene emesso `switchReady`. `SessionHandler` allora:

1. crea una **nuova** istanza `GeminiLiveVoice` (nuova WebSocket verso Google),
2. inietta un system prompt completo nella `setup` event della nuova connessione:
    - prompt base del professore,
    - warning SESSION CONTINUATION (non re-introdurti),
    - stato compatto come checklist markdown con i mastery score aggiornati,
    - turni del volatile buffer (scambi avvenuti durante l’estrazione — “DO NOT REPEAT”),
    - ancora `YOUR LAST MESSAGE` (anti-repetition guard),
3. connette la nuova WebSocket,
4. distrugge la vecchia WebSocket (la vecchia cronologia viene **intenzionalmente scartata**),
5. resetta il baseline del contatore token al valore corrente.

Lo studente vede al massimo un messaggio di stato di 1–2 secondi tipo: "Ottimizzazione della memoria in corso...". Il professore continua esattamente da dove aveva interrotto, chiedendo il prossimo sottotema non ancora verificato.

**Importante:** la nuova WebSocket **non** usa un resumption handle di Google. Questo significherebbe ripristinare il contesto completo precedente — annullando il risparmio sui costi e creando un conflitto di “doppia memoria” (cronologia nativa vs stato compatto iniettato). I resumption handle si usano solo per disconnessioni inattese (vedi sezione successiva).

#### Riepilogo visivo del flusso

```text
Turni 1–10:  Conversazione normale (il conteggio token cresce)
                   ContextManager accumula la trascrizione

Turno 10:    Delta token >= 15.000 → flag extraction
                   Prossimo turnComplete → avvio estrazione LLM (async, ~1–2 s)
                   Volatile buffer inizia a catturare i nuovi turni

Estrazione   gemini-flash-lite legge il delta → produce stato JSON compatto
in corso:    (invisibile all’utente, il professore può ancora parlare)

Turno 11:    Estrazione completata → flag switchReady
Turno 12:    turnComplete (il professore finisce di parlare) → emit switchReady
                   Nuova WS GeminiLive con stato compatto iniettato
                   Vecchia WS distrutta
                   Contatore token resettato a 0 (relativo al nuovo punto di switch)

Turno 13+:   La conversazione continua senza soluzione di continuità, token bassi
```

---

## 8. Ripresa della sessione (disconnessioni inattese)

La Gemini Live API di Google chiude le connessioni WebSocket dopo circa 10 minuti di wall-clock time. Anche interruzioni di rete possono far cadere la connessione. Questo viene gestito separatamente dal context cycling:

1. uno spy raw sulla connessione Gemini cattura i messaggi `sessionResumptionUpdate` man mano che arrivano; l’ultimo resumption handle viene salvato in `SessionHandler.resumptionHandle`,
2. quando viene rilevata una close/error inattesa, `scheduleReconnect()` aspetta 1,5 s e chiama `connectToGemini(isReconnect: true)`,
3. la nuova connessione inserisce il resumption handle nell’evento `setup` così Google ripristina lo stato nativo della conversazione,
4. lo studente vede "Connessione ripristinata." e il professore continua senza interruzioni,
5. massimo 5 tentativi; oltre questo viene mostrato un errore e l’utente deve ricaricare.

Questo è **diverso** dal percorso di context-switch: qui vogliamo il ripristino completo della conversazione, non il risparmio sui costi.

---

## 9. Tracciamento dei costi

`SessionCostTracker` accumula l’uso dei token da ogni payload `usageMetadata` ricevuto da Gemini:

| Tipo di token | Origine | Variabile prezzo |
|--------------|---------|------------------|
| `inputText` | System prompt + testo tool result | `GOOGLE_PRICE_TEXT_INPUT_PER_1M` |
| `inputAudio` | PCM del microfono dello studente | `GOOGLE_PRICE_AUDIO_INPUT_PER_1M` |
| `outputText` | Trascrizione del professore | `GOOGLE_PRICE_TEXT_OUTPUT_PER_1M` |
| `outputAudio` | Audio parlato del professore | `GOOGLE_PRICE_AUDIO_OUTPUT_PER_1M` |
| Summary LLM | Chiamata di pre-sintesi del documento | `GOOGLE_PRICE_TEXT_INPUT_PER_1M_LITE` |
| Extraction LLM | Chiamate di compaction del contesto | `GOOGLE_PRICE_TEXT_INPUT_PER_1M_LITE` |

Un breakdown completo dei costi (USD totali, per modalità, per operazione) viene aggiunto al log della sessione alla chiusura. Se le variabili di prezzo non sono impostate, i costi vengono mostrati come `null`; i conteggi token vengono comunque sempre tracciati.

---

## 10. Logging delle sessioni

Ogni sessione scrive due file in `logs/sessions/`:

- `YYYY-MM-DD_HH-MM-SS_<id>.log` — report leggibile con transcript, chiamate RAG, delta token per episodio e riepilogo costi.
- `YYYY-MM-DD_HH-MM-SS_<id>.json` — equivalente machine-readable per analisi programmatica.

Una sessione è divisa in **episodi** — uno per ogni connessione WebSocket (iniziale, reconnect o context switch). Ogni episodio registra il proprio slice di transcript, le chiamate RAG, il delta token e lo stato JSON compatto generato prima della fine dell’episodio.

---

## 11. Altre personalità assistant

| ID | Nome | Note |
|----|------|------|
| `professor` | Il Professore | Persona principale; RAG o Free Roam a seconda dei documenti caricati |
| `interview_coach` | HR Interviewer | Simula un colloquio di lavoro; usa RAG per estrarre azienda/ruolo dalla job description caricata |
| `study_tutor` | Study Tutor | Spiega concetti; traccia concetti compresi/in difficoltà |
| `audioguide` | Audio Guide | Guida di museo; usa RAG sulle descrizioni delle opere |
| `immigration_assistant` | Immigration Assistant | Consigli pratici in linguaggio semplice; vocabolario A1/A2 |
| `language_tutor` | Language Tutor | Conversazione guidata; integra le correzioni nel flusso |

Tutte le personalità condividono la stessa infrastruttura di WebSocket cycling, RAG e session logging. Ognuna ha il proprio schema di stato compatto in `src/services/contextManager/schemas.ts`.

---

## 12. Avvio del progetto

### Prerequisiti

- Node.js >= 22.13.0
- Una chiave Google AI Studio o Google Cloud con accesso a Gemini Live e ai modelli di embedding.

### Setup

```bash
cp .env.example .env
# Compilare almeno: GEMINI_LIVE_API_KEY, GEMINI_LLM_API_KEY, GEMINI_EMBEDDING_API_KEY
npm install
npm run dev
# Aprire http://localhost:3000
```

### Script disponibili

| Script | Cosa fa |
|--------|---------|
| `npm run dev` | Avvia il server con live reload via `tsx` |
| `npm run build` | Compila TypeScript in `dist/` |
| `npm run start` | Avvia l’output compilato |
| `npm run mastra:dev` | Avvia Mastra Studio su `localhost:4111` (opzionale, per ispezionare gli agent) |

---

## 13. Struttura del repository

```text
src/
   agent/
      agentFactory.ts          - Crea una GeminiLiveVoice + Mastra Agent per sessione
   client/
      cli.ts                   - Client CLI opzionale per test
   config/
      professorConfig.ts       - Tutti i system prompt + VOICE_CONFIG
   server/
      index.ts                 - Entrypoint server HTTP Express + WebSocket
      sessionHandler.ts        - Lifecycle della sessione, routing audio, logica reconnect
      documentService.ts       - Parsing PDF + generazione LLM del topic summary + cache su disco
      documentFileUtils.ts     - Parser PDF/TXT/MD (pdf-parse + fs)
      documentConfigStore.ts   - Registry temporaneo della configurazione upload (consumata alla lettura)
      ragService.ts            - Vector store DuckDB + embedding + semantic search
      sessionCostTracker.ts    - Accounting token/costi per sessione
      sessionLogger.ts         - Scrive logs/sessions/*.log e *.json
      usageTracker.ts          - Appende l’uso aggregato a un file log master
   services/
      contextManager/
         contextManager.ts      - Monitoraggio soglia token + estrazione + scheduling switch WS
         schemas.ts             - Schema Zod per lo stato compatto di ogni persona
         index.ts               - Re-export

public/                      - Frontend statico browser (HTML/CSS/JS, servito da Express)
logs/
   sessions/                  - Transcript + log costo per sessione (gitignored)
   summaries/                 - Summary documenti cache-ati per SHA-256 (gitignored)
   uploads/                   - File upload temporanei (gitignored)
rag-docs/                    - (Opzionale) documenti RAG pre-posizionati
```

