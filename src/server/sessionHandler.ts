// src/server/sessionHandler.ts
//
// One instance of this class is created per browser WebSocket connection.
// It owns a ProfessorAgent and pipes audio in both directions:
//   Browser mic PCM → GeminiLive → Browser speaker PCM
//
// Protocol (all text frames, JSON):
//   Browser → Server  { type: 'start_session' }
//   Browser → Server  { type: 'end_session' }
//   Browser → Server  { type: 'audio_chunk', data: string }   ← base64 Int16 PCM, 16kHz mono
//   Server  → Browser { type: 'transcript', role: 'user'|'model', text: string }
//   Server  → Browser { type: 'status',     message: string }
//   Server  → Browser { type: 'error',      message: string }
//   Server  → Browser { type: 'tts_audio',  data: string }    ← base64 Int16 PCM, 24kHz mono

import { WebSocket, type RawData } from 'ws';
import { createProfessorAgent, type ProfessorAgent } from '../agent/professorFactory.js';
import { browserRagService } from './ragService.js';

export class SessionHandler {
  private ws: WebSocket;
  private professor: ProfessorAgent | null = null;
  private sessionId: string;
  private isStarting = false;
  private pendingMicByte: Buffer | null = null;
  private pendingTtsByte: Buffer | null = null;
  private geminiWs: WebSocket | null = null;
  private geminiWsMessageListener: ((data: RawData) => void) | null = null;

  constructor(ws: WebSocket, sessionId: string) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.setupWebSocketListeners();
    console.log(`[${this.sessionId}] Session created`);
  }

  // ─── WebSocket Listeners ────────────────────────────────────────────────────

  private setupWebSocketListeners() {
    this.ws.on('message', (data: RawData) => {
      const normalized = this.normalizeIncomingMessage(data);

      // All messages are JSON text frames — audio_chunk carries base64 payload
      if (typeof normalized === 'string') {
        this.handleControlMessage(normalized);
        return;
      }

      // Some ws clients deliver text frames as Buffer, so decode and parse JSON.
      const asString = normalized.toString();
      if (asString[0] === '{') {
        this.handleControlMessage(asString);
      }
    });

    this.ws.on('close', () => {
      console.log(`[${this.sessionId}] WebSocket closed — cleaning up`);
      this.cleanup();
    });

    this.ws.on('error', (err) => {
      console.error(`[${this.sessionId}] WebSocket error:`, err.message);
      this.cleanup();
    });
  }

  private normalizeIncomingMessage(data: RawData): Buffer | string {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data);
    return data;
  }

  // ─── Control Messages ───────────────────────────────────────────────────────

  private async handleControlMessage(raw: string) {
    let msg: { type: string; data?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[${this.sessionId}] Non-JSON control message:`, raw);
      return;
    }

    switch (msg.type) {
      case 'start_session':
        await this.startSession();
        break;
      case 'end_session':
        await this.cleanup();
        break;
      case 'audio_chunk':
        // Browser sends mic audio as base64-encoded Int16 PCM (16kHz mono)
        if (!msg.data || !this.professor) break;

        {
          let decoded = Buffer.from(msg.data, 'base64');

          // Preserve alignment across chunk boundaries to avoid dropping bytes.
          if (this.pendingMicByte) {
            decoded = Buffer.concat([this.pendingMicByte, decoded]);
            this.pendingMicByte = null;
          }

          let aligned = decoded;
          if (decoded.byteLength % 2 !== 0) {
            this.pendingMicByte = decoded.slice(decoded.byteLength - 1);
            aligned = decoded.slice(0, decoded.byteLength - 1);
          }

          if (aligned.byteLength === 0) break;

          try {
            const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
            await this.professor.voice.send(int16);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!msg.includes('closed')) {
              console.warn(`[${this.sessionId}] Audio send error:`, msg);
            }
          }
        }
        break;
      default:
        console.warn(`[${this.sessionId}] Unknown message type: ${msg.type}`);
    }
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  private async startSession() {
    if (this.professor || this.isStarting) {
      this.sendStatus('Session already active');
      return;
    }

    this.isStarting = true;

    let createdProfessor: ProfessorAgent | null = null;

    try {
      this.sendStatus('Connecting to MemorAIz Assistant...');

      void browserRagService.ensureReady().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.sessionId}] RAG warmup failed:`, msg);
      });

      // Create a fresh, isolated agent for this user
      createdProfessor = createProfessorAgent();
      const { voice } = createdProfessor;

      // ── Listen for audio coming BACK from Gemini → forward to browser ──────
      voice.on('speaker', (audioStream: NodeJS.ReadableStream) => {
        audioStream.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (this.ws.readyState !== WebSocket.OPEN) return;

          let buf: Buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk)
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);

          // Preserve alignment across chunk boundaries to avoid dropping bytes.
          if (this.pendingTtsByte) {
            buf = Buffer.concat([this.pendingTtsByte, buf]);
            this.pendingTtsByte = null;
          }

          if (buf.byteLength % 2 !== 0) {
            this.pendingTtsByte = buf.slice(buf.byteLength - 1);
            buf = buf.slice(0, buf.byteLength - 1);
          }

          if (buf.byteLength === 0) return;

          // Send as JSON+base64 so the browser decodes at the correct
          // 24kHz sample rate with no format ambiguity
          this.sendJSON({ type: 'tts_audio', data: buf.toString('base64') });
        });

        audioStream.on('error', (streamErr: Error) => {
          console.warn(`[${this.sessionId}] Speaker stream error:`, streamErr.message);
        });

        audioStream.on('end', () => {
          this.pendingTtsByte = null;
        });
      });

      // ── Listen for transcriptions (both user and model text) ───────────────
      voice.on('writing', ({ text, role }: { text: string; role: string }) => {
        this.sendJSON({ type: 'transcript', role, text });
        console.log(`[${this.sessionId}] ${role}: ${text}`);
      });

      voice.on('toolCall', ({ name, args, id }: { name: string; args: unknown; id: string }) => {
        console.log(`[${this.sessionId}] Tool call: ${name} (id=${id})`, args);
      });

      // ── Forward any errors to the browser ─────────────────────────────────
      voice.on('error', (err: { message: string; code?: string; details?: unknown }) => {
        console.error(`[${this.sessionId}] Voice error:`, err);
        this.sendJSON({ type: 'error', message: err.message });
      });

      this.attachRagTool(voice);

      // Establish the WebSocket to Google Live API
      await voice.connect();

      this.attachGeminiInterruptLogger(voice);

      // Mark session as active only after the voice connection is established.
      this.professor = createdProfessor;

      this.sendStatus('Connected! MemorAIz Assistant is ready.');

      // ── Gemini 3.1: trigger the model to speak first ───────────────────────
      // Gemini 3.1 rejects `client_content` (used by voice.speak()) mid-session.
      // The correct approach is `realtimeInput` with a `text` field, sent raw
      // over the underlying WebSocket that Mastra exposes via connectionManager.
      this.geminiSpeakFirst(
        voice,
        `Sei l'assistente di MemorAIz. ` +
          `Presentati, poi chiedi all'utente come puoi aiutarlo oggi. ` +
          `Quando la richiesta riguarda documenti, usa il tool search_documents prima di rispondere.`,
      );

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Failed to start session:`, message);
      this.sendStatus(`Connection failed: ${message}`);
      this.sendJSON({ type: 'error', message: `Failed to connect: ${message}` });
      this.professor = null;
      if (createdProfessor) {
        await createdProfessor.destroy();
      }
    } finally {
      this.isStarting = false;
    }
  }

  // ─── Gemini 3.1 "speak first" ───────────────────────────────────────────────
  //
  // voice.speak() sends `client_content`, which Gemini 3.1 rejects with 1007.
  // Instead we send `realtimeInput: { text }` directly on the raw WebSocket.
  // Mastra keeps the underlying WS on voice.connectionManager (accessible via
  // getWebSocket()), which we reach through the `any` cast.
  //
  private getGeminiWebSocket(voice: any): WebSocket | undefined {
    return (
      voice?.connectionManager?.getWebSocket?.() ??
      voice?.connectionManager?.ws ??
      voice?.ws
    );
  }

  private attachGeminiInterruptLogger(voice: any) {
    const geminiWs = this.getGeminiWebSocket(voice);
    if (!geminiWs) {
      console.warn(`[${this.sessionId}] VAD/interrupt logger: could not find Gemini WebSocket`);
      return;
    }

    // Ensure we never stack duplicate listeners on reconnects.
    if (this.geminiWs && this.geminiWsMessageListener) {
      this.geminiWs.off('message', this.geminiWsMessageListener);
    }

    this.geminiWs = geminiWs;

    this.geminiWsMessageListener = (raw: RawData) => {
      try {
        const payload = this.normalizeIncomingMessage(raw);
        const asString = typeof payload === 'string' ? payload : payload.toString();
        const data = JSON.parse(asString) as {
          serverContent?: {
            interrupted?: boolean;
          };
        };

        if (data.serverContent?.interrupted === true) {
          const ts = new Date().toISOString();
          console.warn(`[${this.sessionId}] [${ts}] VAD interruption detected (serverContent.interrupted=true)`);
        }
      } catch {
        // Ignore non-JSON frames and parse errors; this listener is best-effort diagnostics only.
      }
    };

    geminiWs.on('message', this.geminiWsMessageListener);
  }

  private geminiSpeakFirst(voice: any, text: string) {
    try {
      const geminiWs = this.getGeminiWebSocket(voice);

      if (!geminiWs) {
        console.warn(`[${this.sessionId}] geminiSpeakFirst: could not find underlying WebSocket`);
        return;
      }

      if (geminiWs.readyState !== WebSocket.OPEN) {
        console.warn(`[${this.sessionId}] geminiSpeakFirst: WebSocket not open (state=${geminiWs.readyState})`);
        return;
      }

      const message = JSON.stringify({ realtimeInput: { text } });
      geminiWs.send(message);
      console.log(`[${this.sessionId}] geminiSpeakFirst: sent realtimeInput text → "${text}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.sessionId}] geminiSpeakFirst failed:`, msg);
    }
  }

  private attachRagTool(voice: any) {
    voice.addTools({ // addTools is a method provided by the GeminiLiveVoice instance that allows us to define custom tools that the language model can call during its execution.
      // we are saying to gemini that if he needs to search for information in the indexed PDF documents (e.g. the user has asked a question that requires information retrieval),
      // he can call the tool named "search_documents" and provide a query string as input. Calling this tool concretely means that gemini will return to our server a response indicating that the tool was called, along with the query, and then our server will execute the provided function to perform the search in the RAG system and return the results back to Gemini, which can then use that information to generate a more informed response to the user.
      // Our server will understand that gemini has called the tool because of the "toolCall" event listener we set up on the voice instance, which will log the tool call and its arguments. The actual execution of the search_documents tool is defined in the execute function, where we take the query input, perform the search using our browserRagService, and return the relevant context and sources back to Gemini.
      search_documents: {
        description: 'Cerca informazioni nei PDF locali indicizzati dal server.',
        parameters: {
              type: 'object',
              properties: {
                query: {
                  type: 'string',
                  description: 'Query breve e precisa per cercare nei documenti.',
                },
              },
              required: ['query'],
        },
        execute: async (input: { query?: string }) => {
          // this is the definition of what OUR SERVER does when Gemini calls the "search_documents" tool. We take the input query, validate it, and then use our browserRagService to search for relevant context in the indexed PDF documents. We then return an object containing the relevant context, the list of source file names, and the scores for each source back to Gemini.
                  const query = String(input?.query ?? '').trim();
                  if (!query) {
                    return {
                      result: 'Errore: query vuota.',
                      sources: [],
                    };
                  }

                  this.sendStatus(`RAG: ricerca nei documenti per "${query}"`);

                  const { relevantContext, sources, scoredSources } = await browserRagService.queryRelevantContext(query, 5);

                  this.sendJSON({ // we send a JSON message back to the browser with the type 'rag_tool_called', including the original query, the list of source file names, and the scores for each source
                    type: 'rag_tool_called',
                    query,
                    sources,
                    scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
                  });

                  if (!relevantContext) {
                    if (sources.length > 0) {
                      this.sendStatus(`RAG: trovate fonti, ma poco contesto testuale (${sources.join(', ')}).`);
                      return {
                        result: `Documenti trovati: ${sources.join(', ')}.`,
                        sources,
                        scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
                      };
                    }

                    this.sendStatus('RAG: nessuna corrispondenza trovata.');
                    return {
                      result: 'Nessuna corrispondenza nei documenti caricati.',
                      sources,
                      scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
                    };
                  }

                  this.sendStatus(`RAG: trovate ${sources.length || 1} fonti rilevanti.`);

                  return {
                    result: relevantContext,
                    sources,
                    scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
                  };
                  // what we put in the return object of the execute function is what gets sent back to Gemini as the output of the tool call. Gemini can then use this information in its response generation, for example by including the relevant context in its answer to the user's question. The sources and scores can also be used for attribution or for deciding how much weight to give to the retrieved context in generating the response.
        },
      },
    });
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  private async cleanup() {
    this.pendingMicByte = null;
    this.pendingTtsByte = null;

    if (this.geminiWs && this.geminiWsMessageListener) {
      this.geminiWs.off('message', this.geminiWsMessageListener);
      this.geminiWsMessageListener = null;
      this.geminiWs = null;
    }

    if (this.professor) {
      await this.professor.destroy();
      this.professor = null;
      console.log(`[${this.sessionId}] Professor agent destroyed`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private sendJSON(obj: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private sendStatus(message: string) {
    this.sendJSON({ type: 'status', message });
  }
}