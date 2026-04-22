# MemorAIz — AI Oral Exam Assistant (H-Farm)

> **For reviewers:** This document is intended to give a complete, honest picture of how the system works under the hood — from the browser microphone all the way to Google's Gemini Live API and back. Nothing is glossed over.

---

## Table of Contents

1. [What it is](#1-what-it-is)
2. [High-level architecture](#2-high-level-architecture)
3. [The Professor persona in depth](#3-the-professor-persona-in-depth)
4. [Why and how we pre-summarise the document (RAG topic-seeding)](#4-why-and-how-we-pre-summarise-the-document-rag-topic-seeding)
5. [Real-time RAG during conversation](#5-real-time-rag-during-conversation)
6. [Voice Activity Detection (VAD) — why and how](#6-voice-activity-detection-vad--why-and-how)
7. [WebSocket token cycling — why and how](#7-websocket-token-cycling--why-and-how)
8. [Session resumption (unexpected disconnects)](#8-session-resumption-unexpected-disconnects)
9. [Cost tracking](#9-cost-tracking)
10. [Session logging](#10-session-logging)
11. [Other assistant personas](#11-other-assistant-personas)
12. [Running the project](#12-running-the-project)
13. [Repository layout](#13-repository-layout)

---

## 1. What it is

MemorAIz is a **real-time voice AI** that simulates an oral university exam for H-Farm students. A student opens a browser, uploads a lecture transcript (or any study document), and is immediately put in front of a speaking, listening, questioning professor. The professor:

- speaks with a natural Italian academic tone using Google's Gemini Live text-to-speech/speech-to-text API,
- follows a structured syllabus derived from the uploaded document,
- asks questions, gives one-line feedback, tracks mastery per subtopic,
- awards a final grade when all topics have been covered.

Beyond the professor, the same runtime hosts five other assistant personas (interview coach, study tutor, audio guide, immigration assistant, language tutor) all sharing the same infrastructure.

---

## 2. High-level architecture

```
Browser (public/)
  │  Silero VAD (ONNX/WASM)
  │  WebAudio PCM capture (16 kHz, 16-bit, mono)
  │  WebAudio playback (24 kHz, 16-bit, mono)
  │
  │  WebSocket (JSON control frames + base64 PCM chunks)
  │
Node.js Server (src/server/index.ts)  <── Express HTTP (serves public/)
  │
  ├── SessionHandler (one instance per browser WS connection)
  │     ├── DocumentService      – parse PDFs/TXT, generate topic summary via LLM
  │     ├── BrowserRagService    – DuckDB vector store, semantic search
  │     ├── ContextManager       – token monitoring, compaction, WS-switch scheduling
  │     ├── SessionCostTracker   – token/cost accounting
  │     └── SessionLogger        – per-session .log + .json files
  │
  └── createProfessorAgent()     – per-session GeminiLiveVoice + Mastra Agent
        │
        │  Bidirectional WebSocket (Google BidiGenerateContent)
        │
      Google Gemini Live API
        ├── Speech-to-text (user audio → transcript)
        ├── LLM reasoning + tool calls
        └── Text-to-speech (model text → audio)
```

Every browser connection gets its own isolated `SessionHandler` instance. There is **no shared state between users**.

---

## 3. The Professor persona in depth

### Two modes

| Mode | Triggered when | Behaviour |
|------|----------------|-----------|
| **RAG** | A summary/support document is uploaded | Syllabus extracted at start; `search_documents` used for every subtopic |
| **Free Roam** | No document uploaded | Professor improvises based on the student's chosen subject; concepts discovered on-the-fly |

### The exam flow (RAG mode)

1. **Phase 1 – Opening.** The professor introduces itself as "l'assistente del professore di [subject] per il college H-Farm", deduces the subject from the syllabus, and asks the student's name.
2. **Phase 2 – Topic selection.** Lists macro-topics still at mastery score 0. The student (or the professor) picks where to start.
3. **Phase 3 – Exam loop.** For each subtopic:
   - Calls `search_documents` with the subtopic name to retrieve grounded content from the RAG index.
   - Formulates a question **only** from the retrieved text.
   - Gives feedback: "Corretto" / "Quasi" / "Non proprio" + one-line correction if needed.
   - Updates the subtopic's mastery score (0–3) in the compact state.
4. **Phase 4 – Final grade.** When all subtopics are at mastery ≥ 2 (or the student asks for a grade), the professor gives a score with justification.

### Mastery scoring

| Score | Meaning |
|-------|---------|
| 0 | Not yet discussed |
| 1 | Major gaps — professor had to explain |
| 2 | Sufficient — student answered with hints |
| 3 | Strong — student answered correctly without help |

---

## 4. Why and how we pre-summarise the document (RAG topic-seeding)

### The hallucination problem

Without pre-processing, the professor's only way to know what topics exist in the uploaded document would be to search for them at runtime. But that creates a chicken-and-egg problem: to search for a topic, you need to know what to search for.

A naive solution would be to call `search_documents("next topic to discuss")` or `search_documents("main subjects in the document")`. This fails in practice because:

- The vector store does **cosine similarity** between the query embedding and chunk embeddings. Vague queries like "next topic" match poorly against dense academic text.
- The professor would retrieve irrelevant chunks and hallucinate topics that do not exist in the document, or miss chapters that are present.

### The solution: one LLM call at session start

When the student uploads a document, **before** the Gemini Live WebSocket is even opened, `DocumentService.getOrGenerateSummary()` does the following:

```
1. Parse the uploaded file (PDF or TXT) → normalised plaintext
2. Compute SHA-256 hash of the combined text
3. Check logs/summaries/<hash>_summary.json on disk  (cache)
   CACHE HIT  → load JSON instantly, zero LLM cost
   CACHE MISS → call gemini-3.1-flash-lite-preview with the full text
                prompt: "Extract a detailed topic outline. Return only topics
                         explicitly written in the source text."
                output: { main_topics: [ { topic, subtopics: [...] } ] }
                save to disk for future sessions with the same document
```

The model used is intentionally **small and cheap** (Gemini Flash Lite). It does not need to reason — it only needs to extract a structured list from text it can read in full.

#### Context: how we get the document at H-Farm

At H-Farm, every lecture already comes with an AI-generated transcript. The professor or course coordinator uploads that transcript (or any study PDF) through the browser UI. This document is prepared externally; the system's job is only to parse and index it.

#### Concrete example

Imagine a student uploads a lecture transcript about the Cold War. The text contains sections on the Marshall Plan, the Berlin Wall, NATO, and the Space Race.

The LLM produces:

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

This JSON is then converted to a compact markdown checklist and appended to the professor's system prompt **before** the Gemini Live connection is opened:

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

The professor now knows the full syllabus from the very first message. When it asks about "Construction in 1961" it calls `search_documents("Construction in 1961")` — a specific, grounded query that reliably returns the relevant passage from the vector index.

**No hallucination. No vague searches. Zero extra latency for returning users (cache hit).**

### The two document upload fields

The browser UI exposes two distinct upload areas:

| Field | Purpose |
|-------|---------|
| **Base document** (summary source) | Used **only** for the one-off LLM topic extraction. Typically the full lecture transcript. |
| **Support documents** (RAG source) | Chunked, embedded, and stored in the DuckDB vector index. Queried at runtime by `search_documents`. |

If only the base document is uploaded, it is reused for both purposes. If only support documents are uploaded, the topic-extraction step is skipped.

---

## 5. Real-time RAG during conversation

The RAG pipeline (`src/server/ragService.ts`) runs alongside the Live session:

1. **Index build** (once per session, async, starts in background while the WS connects):
   - Each uploaded support document is parsed into plaintext.
   - The text is chunked (default: 1200-char chunks, 200-char overlap).
   - Each chunk is embedded using `gemini-embedding-001` (via Google AI SDK).
   - Embeddings + metadata are upserted into a **DuckDB** vector store on disk (`rag.duckdb`).
   - Each session uses its own index name (`pdf_knowledge_<sessionId>`) so multiple users do not collide.

2. **`search_documents` tool** (registered on the Mastra Agent):
   - Called by the professor whenever it needs to formulate a question for a specific subtopic.
   - The query text is embedded, cosine similarity search runs, and the top-K chunks are returned.
   - Chunks below a minimum similarity score are discarded (default: 0.1).
   - The returned text is injected into the professor's context as grounding for the next question.

The professor's prompt explicitly instructs it: *"Call `search_documents` as little as possible — only for new subtopics not already in your context."* This avoids redundant API calls once a passage has already been retrieved.

---

## 6. Voice Activity Detection (VAD) — why and how

### Why VAD?

Google Gemini Live bills **per second of audio streamed**, regardless of whether the user is speaking or silent. In a typical exam session with pauses between answers and the professor's own speaking turns, a naive approach (stream mic audio continuously) would bill for far more audio input tokens than necessary.

VAD solves this by sending microphone audio to the server **only when the user is actually speaking**.

### How it works (two-layer VAD)

**Layer 1 — Silero VAD (browser, local, zero cost):**

`@ricky0123/vad-web` runs the Silero VAD ONNX model inside a WebAssembly worker in the browser. It processes raw microphone frames continuously at negligible compute cost.

- `positiveSpeechThreshold: 0.9` — only triggers on high-confidence speech (reduces false positives from keyboard noise, background chatter).
- `negativeSpeechThreshold: 0.4` — deactivates after confidence drops below 0.4 (allows natural pauses inside a sentence without cutting off).
- `minSpeechMs: 180` — ignores bursts shorter than 180 ms (coughs, clicks).
- `preSpeechPadMs: 160` + server-side preroll buffer (280 ms) — ensures the first syllable is not clipped when speech detection triggers slightly late.

When Silero fires `onSpeechRealStart`:
1. All TTS playback is immediately stopped (the student interrupted the professor).
2. `{ type: 'activity_start' }` is sent over the WebSocket and forwarded to Gemini as `realtimeInput.activityStart`.
3. The preroll buffer (last 280 ms of audio frames captured while VAD was inactive) is flushed to the server.
4. Subsequent microphone frames are streamed as `{ type: 'audio_chunk', data: <base64 PCM> }`.

When Silero fires `onSpeechEnd`:
1. `{ type: 'activity_end' }` is sent and forwarded to Gemini as `realtimeInput.activityEnd`.
2. Microphone streaming stops.
3. Preroll buffer is cleared.

**Layer 2 — Gemini server-side VAD (disabled in our setup):**

The Gemini Live API has its own built-in VAD. We **disable it** via a patched `setup` event (in `agentFactory.ts`), because:
- Our Silero VAD is more responsive (runs locally, zero network latency).
- The server-side VAD would double-bill audio input tokens since we are already doing smart gating on the client.
- Disabling it gives us precise control over `activityStart`/`activityEnd` signals.

### Result

A typical 15-minute session generates roughly 3–4 minutes of actual student speech (the rest is professor speaking, pauses, thinking time). VAD reduces audio input tokens by approximately 70–80% compared to continuous streaming.

---

## 7. WebSocket token cycling — why and how

### The quadratic cost problem

The Gemini Live API maintains a native conversation context window. Every turn in the conversation costs tokens proportional to the **accumulated history**. Turn 1 costs 1x, turn 50 costs 50x. Over a long session the per-turn cost grows linearly, making the total session cost grow **quadratically**.

For a 30-minute exam with many question/answer pairs, this becomes expensive. We need a way to reset the token counter periodically without losing conversational continuity.

### The solution: Observational Memory + WebSocket cycling

`ContextManager` (`src/services/contextManager/contextManager.ts`) implements this in several steps.

#### Step 1 — Token monitoring

After each Gemini message, the server parses the `usageMetadata` field from the raw WebSocket frame and accumulates `inputText + inputAudio` token counts. `ContextManager.checkTokenThreshold()` is called with the latest snapshot. When:

    (currentTotalInput - lastSwitchTokenCount) >= MEMORY_EXTRACTION_TOKEN_THRESHOLD

the manager sets a flag: "extract on the next turnComplete". The threshold defaults to **50,000 tokens** (configurable via `MEMORY_EXTRACTION_TOKEN_THRESHOLD`).

#### Step 2 — Extraction (at the next natural silence)

`turnComplete` is the signal Gemini sends when the model has finished its response — the silence between turns. This is the ideal moment to do background work:
- The professor has stopped speaking.
- No audio is being streamed.
- A small delay here is invisible to the user.

At this point, `ContextManager` sends the **delta transcript** (only turns since the last extraction) to a small LLM (`gemini-3.1-flash-lite-preview`, with `gemini-2.5-flash-lite` as backup) with a structured extraction prompt:

```
CURRENT STATE: <existing JSON state>
NEW TRANSCRIPT DELTA:
[model]: "Parliamo della costruzione del Muro di Berlino nel 1961..."
[user]: "Il muro e stato costruito per impedire la fuga dei cittadini della Germania Est"
[model]: "Esatto! E cosa sai delle reazioni occidentali?"

RULE: Update mastery_score for each subtopic discussed.
      Never add or remove items from topics_to_cover.
      Update student_info, current_topic, behavioral_directives.
```

The LLM produces an updated `professorStateSchema` JSON:

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
  "behavioral_directives": ["Student prefers concise questions"],
  "overall_evaluation": "Strong knowledge of factual events, limited analysis so far."
}
```

This JSON is approximately **200 tokens** versus the original transcript delta that might have been **5,000 tokens**.

#### Step 3 — WebSocket switch (at the NEXT silence)

After extraction completes, the manager waits for the **next** `turnComplete`. This two-turn gap ensures:
1. The professor finishes its current sentence before the swap.
2. Any transcript arriving between extraction start and the switch is captured in a "volatile buffer".

At that `turnComplete`, `switchReady` is emitted. The `SessionHandler` then:

1. Creates a **brand-new** `GeminiLiveVoice` instance (new WebSocket to Google).
2. Injects a fully-assembled system prompt into the new connection's `setup` event:
   - Base professor prompt
   - SESSION CONTINUATION warning (do NOT re-introduce yourself)
   - Compact state as markdown checklist with updated mastery scores
   - Volatile buffer turns (exchanges that happened during extraction — "DO NOT REPEAT")
   - YOUR LAST MESSAGE anchor (the last thing the professor said — anti-repetition guard)
3. Connects the new WebSocket.
4. Destroys the old WebSocket (the old conversation history is **intentionally discarded**).
5. Resets the token counter baseline to the current count.

The student experiences at most a 1–2 second "Ottimizzazione della memoria in corso..." status message. The professor continues exactly where it left off, asking about the next untested subtopic.

**Important:** The new WebSocket does **not** use a Google session resumption handle. That would tell Google to restore the full prior context — negating all cost savings and creating a "double memory" conflict (native history vs injected compact state). Resumption handles are only used for unexpected disconnects (see next section).

#### Visual summary of the flow

```
Turn 1–40:   Normal conversation (token count grows)
             ContextManager accumulates transcript

Turn 40:     Token delta >= 50,000 → flag extraction
             Next turnComplete → kick off extraction LLM call (async, ~1–2 s)
             Volatile buffer starts capturing new turns

Extraction   gemini-flash-lite reads delta → produces compact JSON state
running:     (invisible to user, professor may still be speaking)

Turn 42:     Extraction done → flag switchReady
Turn 43:     turnComplete (professor finished speaking) → emit switchReady
             New GeminiLive WS opens with compact state injected
             Old WS destroyed
             Token counter reset to 0 (relative to new switch point)

Turn 44+:    Conversation continues seamlessly, token counter low again
```

---

## 8. Session resumption (unexpected disconnects)

Google's Gemini Live API terminates WebSocket connections after approximately 10 minutes of wall-clock time. Network interruptions can also drop the connection. This is handled separately from context cycling:

1. A raw WebSocket spy on the Gemini connection captures `sessionResumptionUpdate` messages as they arrive. The latest resumption handle is stored in `SessionHandler.resumptionHandle`.
2. When an unexpected close/error is detected, `scheduleReconnect()` waits 1.5 s and calls `connectToGemini(isReconnect: true)`.
3. The new connection injects the resumption handle into the `setup` event so Google restores the native conversation state.
4. The student sees "Connessione ripristinata." and the professor continues without interruption.
5. Maximum 5 attempts; after that, an error is shown and the user must reload.

This is **different** from the context-switch path: here we want full conversation restoration, not cost reduction.

---

## 9. Cost tracking

`SessionCostTracker` accumulates token usage from every `usageMetadata` payload received from Gemini:

| Token type | Source | Price env var |
|------------|--------|---------------|
| `inputText` | System prompt + tool results text | `GOOGLE_PRICE_TEXT_INPUT_PER_1M` |
| `inputAudio` | Student microphone PCM | `GOOGLE_PRICE_AUDIO_INPUT_PER_1M` |
| `outputText` | Professor transcript | `GOOGLE_PRICE_TEXT_OUTPUT_PER_1M` |
| `outputAudio` | Professor speech PCM | `GOOGLE_PRICE_AUDIO_OUTPUT_PER_1M` |
| Summary LLM | Document pre-summary call | `GOOGLE_PRICE_TEXT_INPUT_PER_1M_LITE` |
| Extraction LLM | Context compaction calls | `GOOGLE_PRICE_TEXT_INPUT_PER_1M_LITE` |

A full cost breakdown (total USD, per-modality, per-operation) is appended to the session log at teardown. If price env vars are not set, costs are shown as `null`; token counts are always tracked regardless.

---

## 10. Session logging

Every session writes two files to `logs/sessions/`:

- `YYYY-MM-DD_HH-MM-SS_<id>.log` — human-readable report with transcript, RAG calls, token deltas per episode, and cost summary.
- `YYYY-MM-DD_HH-MM-SS_<id>.json` — machine-readable equivalent for programmatic analysis.

A session is divided into **episodes** — one per WebSocket connection (initial, reconnect, or context switch). Each episode records its own transcript slice, RAG calls, token delta, and the compact JSON state generated just before the episode ended.

---

## 11. Other assistant personas

| ID | Name | Notes |
|----|------|-------|
| `professor` | Il Professore | Primary persona; RAG or Free Roam depending on uploaded docs |
| `interview_coach` | HR Interviewer | Simulates a job interview; uses RAG to extract company/role from uploaded job description |
| `study_tutor` | Study Tutor | Explains concepts; tracks understood/struggling concepts |
| `audioguide` | Audio Guide | Museum tour guide; uses RAG on exhibit descriptions |
| `immigration_assistant` | Immigration Assistant | Simple-language practical advice; A1/A2 vocabulary |
| `language_tutor` | Language Tutor | Conversation practice; integrates corrections into the flow |

All personas share the same WebSocket cycling, RAG, and session logging infrastructure. Each has its own compact state schema in `src/services/contextManager/schemas.ts`.

---

## 12. Running the project

### Prerequisites

- Node.js >= 22.13.0
- A Google AI Studio or Google Cloud API key with access to Gemini Live and embedding models.

### Setup

```bash
cp .env.example .env
# Fill in at minimum: GEMINI_LIVE_API_KEY, GEMINI_LLM_API_KEY, GEMINI_EMBEDDING_API_KEY
npm install
npm run dev
# Open http://localhost:3000
```

### Available scripts

| Script | What it does |
|--------|-------------|
| `npm run dev` | Start the server with live reload via `tsx` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm run start` | Run the compiled output |
| `npm run mastra:dev` | Start Mastra Studio at `localhost:4111` (optional, for agent inspection) |

---

## 13. Repository layout

```
src/
  agent/
    agentFactory.ts          - Creates a GeminiLiveVoice + Mastra Agent per session
  client/
    cli.ts                   - Optional CLI test client
  config/
    professorConfig.ts       - All system prompts + VOICE_CONFIG
  server/
    index.ts                 - Express HTTP + WebSocket server entry point
    sessionHandler.ts        - Core session lifecycle, audio routing, reconnect logic
    documentService.ts       - PDF parsing + LLM topic-summary generation + disk cache
    documentFileUtils.ts     - PDF/TXT/MD file parser (pdf-parse + fs)
    documentConfigStore.ts   - Temporary upload config registry (cleared on consume)
    ragService.ts            - DuckDB vector store + embedding + semantic search
    sessionCostTracker.ts    - Token/cost accounting per session
    sessionLogger.ts         - Writes logs/sessions/*.log and *.json
    usageTracker.ts          - Appends aggregated usage to a master log file
  services/
    contextManager/
      contextManager.ts      - Token threshold monitoring + extraction + WS-switch scheduling
      schemas.ts             - Zod schemas for compact state per assistant persona
      index.ts               - Re-exports

public/                      - Static browser frontend (HTML/CSS/JS, served by Express)
logs/
  sessions/                  - Per-session transcript + cost logs (gitignored)
  summaries/                 - Cached document topic summaries keyed by SHA-256 (gitignored)
  uploads/                   - Temporary uploaded files (gitignored)
rag-docs/                    - (Optional) pre-placed RAG documents
```
