# Il Professore — Italian Language Tutor (Mastra + Gemini Live STS)

A real-time conversational Italian language tutor using **true speech-to-speech**:
browser microphone → Gemini Live API → browser speaker, with ~500ms latency.

## Architecture

```
Browser (mic) ──PCM Int16──► WebSocket Server
                                    │
                             SessionHandler
                             (one per user)
                                    │
                           createProfessorAgent()
                           (factory — isolated per user)
                                    │
                            GeminiLiveVoice
                            (persistent WebSocket
                             to Google Live API)
                                    │
                             Gemini 2.0 Flash Live
                             (audio in → audio out,
                              no STT/TTS pipeline)
                                    │
Browser (speaker) ◄─PCM Int16── WebSocket Server
```

**Why a factory and not a singleton?**  
`GeminiLiveVoice` holds a stateful WebSocket. If you used a singleton agent,
all users would share the same audio stream. The factory pattern creates a
completely isolated `Agent + GeminiLiveVoice` pair per browser connection.

## Project Structure

```
professor-sts/
├── src/
│   ├── config/
│   │   └── professorConfig.ts     # Persona instructions + voice settings
│   ├── agent/
│   │   └── professorFactory.ts    # Factory: creates one agent per user
│   ├── server/
│   │   ├── index.ts               # Express + WebSocket server
│   │   └── sessionHandler.ts      # Per-connection audio routing
│   └── client/
│       └── cli.ts                 # Terminal test (no browser needed)
├── public/
│   └── index.html                 # Browser demo UI
├── .env.example
├── package.json
└── tsconfig.json
```

## Setup

### 1. Get a Google API Key

Go to [Google AI Studio](https://makersuite.google.com/app/apikey) and create an API key.
Make sure the **Generative Language API** is enabled for your project.

### 2. Install and configure

```bash
cd professor-sts
npm install
cp .env.example .env
# Edit .env and paste your GOOGLE_API_KEY
```

### 3. Run

```bash
# Start the server + browser UI
npm run dev

# Then open: http://localhost:3000
```

### 4. (Optional) Terminal-only test

If you want to test from the command line without a browser:

```bash
npm run test:cli
```

This streams your microphone directly to Gemini Live and plays back audio
through your speakers. Press `Ctrl+C` to quit.

## Voice Options

Edit `src/config/professorConfig.ts` to change:

| Field | Options |
|-------|---------|
| `model` | `gemini-2.0-flash-live-001` (stable), `gemini-live-2.5-flash-preview` (latest) |
| `speaker` | `Kore`, `Puck`, `Charon`, `Fenrir` |

## Notes

- The browser captures mic at **16kHz PCM** (what Gemini Live expects as input).
- Gemini outputs **24kHz PCM**, which the browser plays back directly.
- Interruptions work out of the box — you can cut off the professor mid-sentence.
- For production/multi-user: switch to Vertex AI auth (see `professorConfig.ts` comments).
# mastra-conversational-agent
