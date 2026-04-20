# Agente Conversazionale Vocale

Questo progetto implementa un assistente vocale interattivo basato sul framework Mastra, integrato con modelli LLM (Gemini) e un sistema RAG (Retrieval-Augmented Generation) basato su DuckDB. L'infrastruttura è progettata per gestire conversazioni audio bidirezionali in tempo reale dal browser.

## Architettura e Stack Tecnologico

Il progetto è diviso in un backend Node.js/TypeScript e un frontend web leggero.

* **Core Framework:** Mastra (gestione degli agenti, dei flussi e dell'integrazione LLM).
* **Speech-to-Speech Model:** Gemini Live 3.1 (ancora in fase di preview, ovvero Google non lo fa pagare per l'utilizzo, ma è disponibile per test e sviluppo).
* **Database / RAG:** DuckDB. Utilizzato per vettorializzare e recuperare documenti di contesto (es. manuali, guide) da fornire all'agente prima della generazione della risposta.
* **Frontend:** Interfaccia web pura (HTML/JS) per l'acquisizione del microfono e la riproduzione dell'audio generato.

## Flusso Audio e VAD (Voice Activity Detection)

Una delle sfide principali dell'interazione vocale via browser è la gestione continua del flusso audio.

**Scelta Tecnica: VAD Lato Client (Silero)**
Inizialmente, l'invio continuo di streaming audio al server creava problemi di latenza e spreco di risorse. Si è optato per un approccio **VAD lato client** utilizzando `silero_vad_legacy.onnx` eseguito tramite WebAssembly (`ort.min.js`).

* **Come funziona:** Il browser ascolta il microfono in locale e riconosce quando l'utente inizia e finisce di parlare.
* **Vantaggio:** Vengono inviati al server tramite WebSocket (o endpoint API) solo i pacchetti audio contenenti effettivamente la voce dell'utente. Questo riduce drasticamente il traffico di rete, i tempi di attesa e i costi di elaborazione inutile.

## Perche VAD Client + VAD Gemini (Ibrido)

Nel progetto sono stati testati due approcci:

1. invio continuo del microfono al server e delega completa al VAD interno di Gemini
2. gating lato browser con Silero, mantenendo comunque il VAD interno di Gemini attivo lato modello

La soluzione finale e stata la n.2 (ibrida) per motivi pratici.

### Perche non basta solo il VAD integrato di Gemini

Con solo VAD server/model-side, il browser continua a streammare frame audio anche quando l'utente e in silenzio. Questo comporta:

* maggiore traffico WebSocket client→server
* maggiore lavoro di buffering e inoltro lato backend
* meno controllo applicativo sui turni di parlato (inizio/fine turno gestiti solo lato modello)

In altre parole, il VAD di Gemini decide bene "quando trattare il parlato", ma non impedisce da solo l'upload continuo dal browser.

### Come funziona il meccanismo completo

1. **Silero in browser (gate di upload):**
   Il client usa `silero_vad_legacy.onnx` (WebAssembly) per decidere quando l'utente sta parlando.

2. **Invio audio solo quando serve:**
   Durante speech detection il client invia i chunk `audio_chunk`; nei periodi di silenzio evita di inviare frame inutili.

3. **Gemini Live VAD (turn management):**
   Una volta ricevuto audio valido, Gemini continua a fare VAD lato modello per interruption handling, gestione del turno e trascrizione realtime.

4. **Segnali di interruzione del modello:**
   Quando Gemini segnala `serverContent.interrupted`, il server lo intercetta e lo inoltra alla GUI per distinguere chiaramente gli eventi VAD lato modello da quelli locali Silero.

### Risultato operativo

* **Silero:** riduce upload/rumore lato client
* **Gemini VAD:** mantiene robusta la gestione conversazionale lato modello

Questa combinazione fornisce sia efficienza di trasporto sia qualita di interazione.

## Gestione Sessione e Ottimizzazione Costi

Il mantenimento del contesto conversazionale richiede un'attenzione particolare, gestita tramite `sessionHandler.ts` e `sessionCostTracker.ts`.

* **Il Problema:** Nelle conversazioni lunghe, il costo (in termini di token) aumenta in modo quasi esponenziale o lineare ripido, poiché a ogni nuovo scambio l'LLM deve riprocessare tutto il contesto storico precedente.
* **Soluzioni da testare:**
    1.  **Summarization Injection:** Invece di mantenere lo storico completo dei messaggi, dopo un certo numero di botta-e-risposta il server elabora un riassunto testuale della conversazione grazie alle trascrizioni automatiche che Gemini offre (seppur di scarsa qualità e spesso contenenti errori). Al contesto viene aggiunto questo riassunto, e poi si applica `contextCompression=true` per tagliare il contesto ad un determinato numero di token massimi (in modo che non crescano a dismisura).
    2.  **Limitazione delle sessioni:** Lato UX/UI, si potrebbe progettare l'interazione per essere focalizzata su "micro-esperienze" per risolvere il bisogno dell'utente in pochi scambi mirati, evitando sessioni molto lunghe (e molto costose).

## Flessibilità degli Agenti e Use Case

Il sistema è altamente modulare (`src/agent/agentFactory.ts`). Modificando i file di configurazione (come `professorConfig.ts`), è possibile cambiare radicalmente la personalità, le istruzioni di sistema e la base di conoscenza (RAG) dell'agente.

Questo permette di testare e distribuire l'assistente per scenari completamente diversi:
* Professore che simula un interrogazione
* Responsabile HR che simula un colloquio di lavoro
* Tutor per l'apprendimento delle lingue
* Guida museale
* Piattaforma per migranti

## Struttura del Progetto

* `src/server/`: Logica backend (Express/WebSockets, tracking costi, servizi RAG, handler di sessione).
* `src/agent/`: Fabbrica e configurazione degli agenti Mastra.
* `src/config/`: Prompts di sistema e parametri specifici per i vari ruoli dell'agente.
* `public/`: File serviti al client, incluso HTML, logica di acquisizione microfono e modelli VAD compilati (ONNX/WASM).
* `logs/uploads/`: Directory temporanea dove il server salva i file caricati dalla UI (summary e RAG) per la durata della sessione.

## Setup e Avvio Locale

1. Installa le dipendenze:
   ```bash
   npm install
   ```

2. Avvia il server:
   ```bash
   npm run dev
   ```

3. Apri il browser su `http://localhost:3000`.

4. Nella UI, configura le sorgenti documentali con i due campi separati:
   * **Summary document (single file):** file usato per generare il riassunto iniziale.
   * **RAG document(s) (one or more files):** file usati dalla tool `search_documents` durante la conversazione.

5. Regole di comportamento implementate:
   * Se fornisci **summary + RAG**, vengono usati separatamente.
   * Se fornisci **solo summary**, lo stesso file viene riutilizzato anche per il RAG.
   * Se fornisci **solo RAG**, il riassunto iniziale viene saltato e il RAG usa i file caricati.

6. Clicca **Start** per avviare la sessione.
