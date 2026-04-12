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
//   Browser → Server  { type: 'text_prompt', text: string }
//   Server  → Browser { type: 'transcript', role: 'user'|'model', text: string }
//   Server  → Browser { type: 'status',     message: string }
//   Server  → Browser { type: 'error',      message: string }
//   Server  → Browser { type: 'tts_audio',  data: string }    ← base64 Int16 PCM, 24kHz mono

import { WebSocket, type RawData } from 'ws';
import { createProfessorAgent, type ProfessorAgent } from '../agent/agentFactory.js';
import {
  DEFAULT_ASSISTANT_ID,
  getAssistantInstructions,
  isAssistantId,
  type AssistantId,
} from '../config/professorConfig.js';
import { browserRagService } from './ragService.js';
import { SessionCostTracker } from './sessionCostTracker.js';

// How long to wait before attempting a reconnect after Google drops the line.
// Keep this short (1-2 s) so the user barely notices the gap.
const RECONNECT_DELAY_MS = 1500;

// Maximum number of consecutive reconnect attempts before giving up and
// reporting an error to the browser. Prevents infinite loops on hard failures.
const MAX_RECONNECT_ATTEMPTS = 5;

// Resumption tokens are valid for 2 hours after the last session termination
// (per Google docs), but we never need to hold them longer than the lifetime
// of this SessionHandler, so no expiry logic is required here.

export class SessionHandler {
  private ws: WebSocket;
  private professor: ProfessorAgent | null = null;
  private sessionId: string;
  private isStarting = false;
  private pendingMicByte: Buffer | null = null;
  private pendingTtsByte: Buffer | null = null;
  private pendingTextPrompts: string[] = [];
  private costTracker = new SessionCostTracker();
  private sessionCostSummarySent = false;
  private selectedAssistantId: AssistantId = DEFAULT_ASSISTANT_ID;

  // ── Session Resumption state ─────────────────────────────────────────────
  // Google sends sessionResumptionUpdate messages throughout the session.
  // We keep the latest resumable handle so we can pass it on reconnect.
  private resumptionHandle: string | null = null;
  private reconnectAttempts = 0;
  private isReconnecting = false;
  // When true, a deliberate end_session was requested — don't auto-reconnect.
  private intentionalClose = false;

  // ── Raw Gemini WebSocket plumbing ────────────────────────────────────────
  // We attach one message listener to the underlying Gemini WS to capture
  // resumption handles and goAway signals before Mastra processes them.
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

      if (typeof normalized === 'string') {
        this.handleControlMessage(normalized);
        return;
      }

      const asString = normalized.toString();
      if (asString[0] === '{') {
        this.handleControlMessage(asString);
      }
    });

    this.ws.on('close', () => {
      console.log(`[${this.sessionId}] Browser WebSocket closed — cleaning up`);
      this.intentionalClose = true;
      this.cleanup();
    });

    this.ws.on('error', (err) => {
      console.error(`[${this.sessionId}] Browser WebSocket error:`, err.message);
      this.intentionalClose = true;
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
    let msg: { type: string; data?: string; text?: string; assistantId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[${this.sessionId}] Non-JSON control message:`, raw);
      return;
    }

    switch (msg.type) {
      case 'start_session':
        this.selectedAssistantId = this.resolveAssistantId(msg.assistantId);
        await this.startSession();
        break;
      case 'end_session':
        this.intentionalClose = true;
        await this.cleanup();
        break;
      case 'simulate_disconnect':
        if (this.geminiWs) {
          console.log(`[${this.sessionId}] Simulating Google disconnect...`);
          // Forcefully emit an error and terminate to trigger the reconnect logic
          this.geminiWs.emit('error', new Error('Simulated Google WebSocket closure'));
          this.geminiWs.terminate();
        }
        break;
      case 'audio_chunk':
        if (!msg.data || !this.professor) break;
        // Don't forward audio while we're in the middle of a reconnect —
        // the Gemini socket isn't open yet and send() would throw.
        if (this.isReconnecting) break;

        {
          let decoded = Buffer.from(msg.data, 'base64');

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
      case 'text_prompt': {
        const text = String(msg.text ?? '').trim();
        if (!text) break;

        // Mirror typed input immediately in the UI transcript.
        this.sendJSON({ type: 'transcript', role: 'user', text });

        if (this.isReconnecting || !this.professor) {
          this.pendingTextPrompts.push(text);
          this.sendStatus('Messaggio testuale accodato: verra inviato appena la connessione e pronta.');
          break;
        }

        const sent = this.sendRealtimeText(this.professor.voice, text);
        if (!sent) {
          this.pendingTextPrompts.push(text);
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        }
        break;
      }
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

    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.costTracker.reset();
    this.sessionCostSummarySent = false;
    await this.connectToGemini(false);
  }

  /**
   * Core connection method, used for both fresh starts and silent reconnects.
   *
   * @param isReconnect  When true, we pass the resumption handle to Google
   *                     so it restores the conversation state, and we skip
   *                     the opening greeting (Gemini already knows the context).
   */
  private async connectToGemini(isReconnect: boolean) {
    if (this.isStarting) return;
    this.isStarting = true;

    let createdProfessor: ProfessorAgent | null = null;

    try {
      if (!isReconnect) {
        this.sendStatus(`Connecting to ${this.getAssistantLabel(this.selectedAssistantId)}...`);
        void browserRagService.ensureReady().catch((err) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[${this.sessionId}] RAG warmup failed:`, msg);
        });
      }

      const instructions = getAssistantInstructions(this.selectedAssistantId);
      createdProfessor = createProfessorAgent({
        instructions,
        name: this.getAssistantLabel(this.selectedAssistantId),
      });
      const { voice } = createdProfessor;

      const reconnectWithHandle = isReconnect && !!this.resumptionHandle;

      // ── If reconnecting, inject the resumption handle into the setup ──────
      // GeminiLiveVoice doesn't have a first-class API for this, so we patch
      // the setup event exactly like we do for audio responses in the factory.
      if (reconnectWithHandle && this.resumptionHandle) {
        const handle = this.resumptionHandle;
        const anyVoice = voice as any;
        if (typeof anyVoice.sendEvent === 'function') {
          const originalSendEvent = anyVoice.sendEvent.bind(anyVoice);
          anyVoice.sendEvent = (type: string, data: any) => {
            if (type === 'setup' && data?.setup) {
              // Tell Google: "resume from this handle"
              this.withSessionResumption(data, handle);
              console.log(`[${this.sessionId}] Reconnect: injecting resumption handle ${handle.slice(0, 12)}...`);
            }
            return originalSendEvent(type, data);
          };
        }
      }

      // ── Audio from Gemini → Browser ────────────────────────────────────────
      voice.on('speaker', (audioStream: NodeJS.ReadableStream) => {
        audioStream.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (this.ws.readyState !== WebSocket.OPEN) return;

          let buf: Buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk)
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);

          if (this.pendingTtsByte) {
            buf = Buffer.concat([this.pendingTtsByte, buf]);
            this.pendingTtsByte = null;
          }

          if (buf.byteLength % 2 !== 0) {
            this.pendingTtsByte = buf.slice(buf.byteLength - 1);
            buf = buf.slice(0, buf.byteLength - 1);
          }

          if (buf.byteLength === 0) return;

          this.sendJSON({ type: 'tts_audio', data: buf.toString('base64') });
        });

        audioStream.on('error', (streamErr: Error) => {
          console.warn(`[${this.sessionId}] Speaker stream error:`, streamErr.message);
        });

        audioStream.on('end', () => {
          this.pendingTtsByte = null;
        });
      });

      // ── Transcripts ────────────────────────────────────────────────────────
      voice.on('writing', ({ text, role }: { text: string; role: string }) => {
        this.sendJSON({ type: 'transcript', role, text });
        console.log(`[${this.sessionId}] ${role}: ${text}`);
      });

      voice.on('toolCall', ({ name, args, id }: { name: string; args: unknown; id: string }) => {
        console.log(`[${this.sessionId}] Tool call: ${name} (id=${id})`, args);
      });

      // ── Voice errors → try to reconnect ────────────────────────────────────
      // This fires when the Gemini WebSocket is closed by Google (e.g. the
      // ~10-minute connection limit). We attempt a silent reconnect unless
      // the user explicitly ended the session.
      voice.on('error', (err: { message: string; code?: string; details?: unknown }) => {
        console.warn(`[${this.sessionId}] Voice error (will attempt reconnect):`, err.message);
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      });

      this.attachRagTool(voice);

      // ── Connect ────────────────────────────────────────────────────────────
      await voice.connect();

      // ── Capture resumption handles from raw Gemini messages ───────────────
      this.attachGeminiMessageSpy(voice);

      // Swap in the new professor atomically
      const oldProfessor = this.professor;
      this.professor = createdProfessor;
      createdProfessor = null; // prevent cleanup in finally block

      if (oldProfessor) {
        // Destroy the old voice instance quietly — its WS is already dead
        oldProfessor.destroy().catch(() => {});
      }

      this.reconnectAttempts = 0;
      this.isReconnecting = false;

      this.flushPendingTextPrompts(voice);

      if (!isReconnect) {
        this.sendStatus(`Connected! ${this.getAssistantLabel(this.selectedAssistantId)} is ready.`);
        // Fresh session: send the opening prompt
        this.geminiSpeakFirst(
          voice,
            this.getOpeningPrompt(this.selectedAssistantId)
        );
      } else {
        if (reconnectWithHandle) {
          // Reconnected: Gemini has context from the resumption handle.
          this.sendStatus('Connessione ripristinata.');
          console.log(`[${this.sessionId}] Session resumed transparently (attempt ${this.reconnectAttempts + 1})`);
        } else {
          // Fallback path: we restored transport but not conversation state.
          this.sendStatus('Connessione ripristinata, ma il contesto precedente non e stato recuperato.');
          console.warn(`[${this.sessionId}] Reconnected without resumption handle: context continuity not guaranteed.`);
        }
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Failed to connect (reconnect=${isReconnect}):`, message);

      if (createdProfessor) {
        await createdProfessor.destroy();
      }

      if (isReconnect && !this.intentionalClose) {
        // Connection attempt itself failed — try again
        this.scheduleReconnect();
      } else if (!isReconnect) {
        this.sendStatus(`Connection failed: ${message}`);
        this.sendJSON({ type: 'error', message: `Failed to connect: ${message}` });
        this.professor = null;
      }
    } finally {
      this.isStarting = false;
    }
  }

  // ─── Reconnect Logic ────────────────────────────────────────────────────────

  private scheduleReconnect() {
    if (this.intentionalClose || this.isReconnecting) return;

    this.reconnectAttempts++;

    if (this.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
      console.error(`[${this.sessionId}] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached. Giving up.`);
      this.sendJSON({ type: 'error', message: 'Impossibile ripristinare la connessione. Ricarica la pagina.' });
      this.cleanup();
      return;
    }

    this.isReconnecting = true;
    console.log(`[${this.sessionId}] Scheduling reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS}ms`);
    this.sendStatus('Riconnessione in corso...');

    setTimeout(() => {
      if (this.intentionalClose) {
        this.isReconnecting = false;
        return;
      }
      this.connectToGemini(true).catch((err) => {
        console.error(`[${this.sessionId}] Reconnect error:`, err);
      });
    }, RECONNECT_DELAY_MS);
  }

  // ─── Raw Gemini WebSocket message spy ───────────────────────────────────────
  //
  // We attach a listener to the underlying Gemini WebSocket to intercept two
  // message types that Mastra doesn't surface:
  //
  //   sessionResumptionUpdate  → contains the latest resumption handle; we
  //                              store it so we can pass it on reconnect.
  //
  //   goAway                   → Google signals it will close the connection
  //                              soon; we use this to log a warning and
  //                              pre-emptively prepare for the reconnect.

  private getGeminiWebSocket(voice: any): WebSocket | undefined {
    return (
      voice?.connectionManager?.getWebSocket?.() ??
      voice?.connectionManager?.ws ??
      voice?.ws
    );
  }

  private attachGeminiMessageSpy(voice: any) {
    const geminiWs = this.getGeminiWebSocket(voice);
    if (!geminiWs) {
      console.warn(`[${this.sessionId}] Message spy: could not find Gemini WebSocket`);
      return;
    }

    // Remove any listener from a previous connection to avoid stacking.
    if (this.geminiWs && this.geminiWsMessageListener) {
      this.geminiWs.off('message', this.geminiWsMessageListener);
    }

    this.geminiWs = geminiWs;

    this.geminiWsMessageListener = (raw: RawData) => {
      try {
        const payload = this.normalizeIncomingMessage(raw);
        const asString = typeof payload === 'string' ? payload : payload.toString();
        const data = JSON.parse(asString) as any;
        // In attachGeminiMessageSpy, dentro il listener
        // const usage = data?.usageMetadata ?? data?.usage_metadata;
        // if (usage) {
        //   console.log(`[${this.sessionId}] RAW usageMetadata turn ${this.costTracker['usageEventsSeen']}:`, 
        //     JSON.stringify(usage));
        // }

        this.costTracker.captureUsageMetadata(data);
        this.mirrorAutomaticTranscriptions(data);

        // ── Capture resumption handle ──────────────────────────────────────
        // Google sends this periodically throughout the session and on every
        // turn completion. We always keep the latest one.
        const update =
          data?.sessionResumptionUpdate ??
          data?.session_resumption_update ??
          data?.sessionResumption?.update ??
          data?.session_resumption?.update;
        if (update) {
          const newHandle = update.handle ?? update.new_handle ?? update.newHandle;
          const resumable = update.resumable ?? true;
          if (newHandle && resumable) {
            this.resumptionHandle = newHandle;
            // Uncomment for verbose debugging:
            // console.log(`[${this.sessionId}] Resumption handle updated: ${newHandle.slice(0, 12)}...`);
          }
        }

        // Some SDK responses expose the active handle directly in setup/session.
        const directHandle =
          data?.setup?.sessionHandle ??
          data?.setup?.session_handle ??
          data?.sessionHandle ??
          data?.session_handle;
        if (directHandle && !this.resumptionHandle) {
          this.resumptionHandle = directHandle;
        }

        // ── Log goAway ─────────────────────────────────────────────────────
        // Google sends this a few seconds before forcefully closing the WS.
        // We don't need to act here — the voice 'error' event will fire when
        // the connection actually drops and trigger scheduleReconnect().
        if (data?.goAway || data?.go_away) {
          const timeLeft = data?.goAway?.timeLeft ?? data?.go_away?.time_left ?? 'unknown';
          console.warn(`[${this.sessionId}] goAway received — connection closing in ${timeLeft}s. Handle ready: ${!!this.resumptionHandle}`);
        }

        // ── Log VAD interruptions ──────────────────────────────────────────
        if (data?.serverContent?.interrupted === true) {
          console.warn(`[${this.sessionId}] VAD interruption detected`);
        }

      } catch {
        // Ignore non-JSON frames — this listener is best-effort
      }
    };

    geminiWs.on('message', this.geminiWsMessageListener);
  }

  // ─── Gemini "speak first" ────────────────────────────────────────────────────

  private geminiSpeakFirst(voice: any, text: string) {
    const sent = this.sendRealtimeText(voice, text);
    if (!sent) {
      console.warn(`[${this.sessionId}] geminiSpeakFirst: WebSocket not ready`);
    }
  }

  private sendRealtimeText(voice: any, text: string): boolean {
    try {
      const geminiWs = this.getGeminiWebSocket(voice);
      if (!geminiWs || geminiWs.readyState !== WebSocket.OPEN) {
        return false;
      }
      geminiWs.send(JSON.stringify({ realtimeInput: { text } }));
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.sessionId}] sendRealtimeText failed:`, msg);
      return false;
    }
  }

  private flushPendingTextPrompts(voice: any) {
    if (this.pendingTextPrompts.length === 0) return;

    const queued = [...this.pendingTextPrompts];
    this.pendingTextPrompts = [];

    for (let i = 0; i < queued.length; i++) {
      const sent = this.sendRealtimeText(voice, queued[i]);
      if (!sent) {
        this.pendingTextPrompts = queued.slice(i);
        break;
      }
    }
  }

  private extractTranscriptionText(payload: any): string {
    if (!payload) return '';
    if (typeof payload === 'string') return payload.trim();

    if (typeof payload.text === 'string') {
      return payload.text.trim();
    }

    const candidates = [
      payload.transcript,
      payload.transcribedText,
      payload.transcribed_text,
      payload.partialText,
      payload.partial_text,
      payload.finalText,
      payload.final_text,
      payload.caption,
      payload.content,
    ];

    for (const value of candidates) {
      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return '';
  }

  private emitTranscriptFromPayload(role: 'user' | 'model', payload: any) {
    const text = this.extractTranscriptionText(payload);
    if (!text) return;

    this.sendJSON({ type: 'transcript', role, text });
    console.log(`[${this.sessionId}] ${role} (transcription): ${text}`);
  }

  private mirrorAutomaticTranscriptions(data: any) {
    const userPayload =
      data?.inputTranscription ??
      data?.input_transcription ??
      data?.serverContent?.inputTranscription ??
      data?.serverContent?.input_transcription ??
      data?.server_content?.input_transcription;

    const modelPayload =
      data?.outputTranscription ??
      data?.output_transcription ??
      data?.serverContent?.outputTranscription ??
      data?.serverContent?.output_transcription ??
      data?.server_content?.output_transcription;

    this.emitTranscriptFromPayload('user', userPayload);
    this.emitTranscriptFromPayload('model', modelPayload);
  }

  private withSessionResumption(data: any, handle: string) {
    if (!data?.setup) return;

    // Keep both variants for compatibility with SDK/API field naming.
    data.setup.session_resumption = { handle };
    data.setup.sessionResumption = { handle };
  }

  // ─── RAG Tool ────────────────────────────────────────────────────────────────

  private attachRagTool(voice: any) { // the model has a field called "tools" which is a map of tool definitions
    voice.addTools({
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
          const query = String(input?.query ?? '').trim();
          if (!query) {
            return { result: 'Errore: query vuota.', sources: [] };
          }

          this.sendStatus(`RAG: ricerca nei documenti per "${query}"`);

          const { relevantContext, sources, scoredSources } = await browserRagService.queryRelevantContext(query, 5);

          this.sendJSON({
            type: 'rag_tool_called',
            query,
            sources,
            scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
          });

          let toolResult: {
            result: string;
            sources: string[];
            scores: Array<{ file: string; score: number }>;
          };

          if (!relevantContext) {
            if (sources.length > 0) {
              this.sendStatus(`RAG: trovate fonti, ma poco contesto testuale (${sources.join(', ')}).`);
              toolResult = {
                result: `Documenti trovati: ${sources.join(', ')}.`,
                sources,
                scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
              };
              this.costTracker.recordRagUsage(toolResult);
              return toolResult;
            }
            this.sendStatus('RAG: nessuna corrispondenza trovata.');
            toolResult = {
              result: 'Nessuna corrispondenza nei documenti caricati.',
              sources,
              scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
            };
            this.costTracker.recordRagUsage(toolResult);
            return toolResult;
          }

          this.sendStatus(`RAG: trovate ${sources.length || 1} fonti rilevanti.`);
          toolResult = {
            result: relevantContext,
            sources,
            scores: scoredSources.map((s) => ({ file: s.file, score: s.score })),
          };
          this.costTracker.recordRagUsage(toolResult);
          return toolResult;
        },
      },
    });
  }

  // ─── Cleanup ─────────────────────────────────────────────────────────────────

  private async cleanup() {
    this.emitSessionCostSummary();

    this.pendingMicByte = null;
    this.pendingTtsByte = null;
    this.pendingTextPrompts = [];
    this.isReconnecting = false;

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

  private emitSessionCostSummary() {
    if (this.sessionCostSummarySent) return;
    this.sessionCostSummarySent = true;

    const { summary, sessionMinutes, pricing } = this.costTracker.getSummary();

    console.log(`[${this.sessionId}] SESSION COST SUMMARY`);
    if (!summary.pricingConfigured) {
      console.warn(
        `[${this.sessionId}] Pricing env missing. Set GOOGLE_PRICE_TEXT_INPUT_PER_1M, GOOGLE_PRICE_TEXT_OUTPUT_PER_1M, GOOGLE_PRICE_AUDIO_INPUT_PER_1M, GOOGLE_PRICE_AUDIO_OUTPUT_PER_1M for USD totals.`,
      );
    }
    console.log(
      `[${this.sessionId}] Input Tokens: ${summary.inputTokens.toLocaleString()} (${summary.inputCostUsd === null ? 'N/A' : `$${summary.inputCostUsd.toFixed(6)}`}) ` +
        `[text=${summary.inputTextTokens.toLocaleString()}, audio=${summary.inputAudioTokens.toLocaleString()}]`,
    );
    console.log(
      `[${this.sessionId}] Output Tokens: ${summary.outputTokens.toLocaleString()} (${summary.outputCostUsd === null ? 'N/A' : `$${summary.outputCostUsd.toFixed(6)}`}) ` +
        `[text=${summary.outputTextTokens.toLocaleString()}, audio=${summary.outputAudioTokens.toLocaleString()}]`,
    );
    console.log(
      `[${this.sessionId}] RAG Tokens (subset of input): ${summary.ragTokens.toLocaleString()} (${summary.ragCostUsd === null ? 'N/A' : `~$${summary.ragCostUsd.toFixed(6)}`}) ` +
        `[calls=${summary.ragCalls}]`,
    );
    console.log(
      `[${this.sessionId}] Growth: ${summary.growth.shape} ` +
        `(delta input first=${Math.round(summary.growth.firstDeltaInput).toLocaleString()}, ` +
        `last=${Math.round(summary.growth.lastDeltaInput).toLocaleString()}, ` +
        `avg=${Math.round(summary.growth.avgDeltaInput).toLocaleString()}, ` +
        `slope/turn=${summary.growth.deltaSlopePerTurn.toFixed(2)})`,
    );
    console.log(
      `[${this.sessionId}] Estimated Cost: ${summary.estimatedCostUsd === null ? 'N/A' : `$${summary.estimatedCostUsd.toFixed(6)}`} ` +
        `(duration ${sessionMinutes.toFixed(2)} min, usage events ${summary.usageEvents})`,
    );

    this.sendJSON({
      type: 'session_cost_summary',
      ...summary,
      sessionMinutes,
      pricing,
      notes: [
        'RAG tokens are an estimate and are already part of input context charges.',
        'Set GOOGLE_PRICE_*_PER_1M in .env for accurate USD totals.',
      ],
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private sendJSON(obj: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private sendStatus(message: string) {
    this.sendJSON({ type: 'status', message });
  }

  private resolveAssistantId(rawAssistantId?: string): AssistantId {
    if (isAssistantId(rawAssistantId)) return rawAssistantId;
    return DEFAULT_ASSISTANT_ID;
  }

  private getAssistantLabel(assistantId: AssistantId): string {
    switch (assistantId) {
      case 'professor':
        return 'Il Professore';
      case 'interview_coach':
        return 'Interview Coach';
      case 'study_tutor':
        return 'Study Tutor';
      case 'audioguide':
        return 'Audioguida';
      case 'immigration_assistant':
        return 'Immigration Assistant';
      case 'language_tutor':
        return 'Language Tutor';
      default:
        return 'MemorAIz Assistant';
    }
  }

  private getOpeningPrompt(assistantId: AssistantId): string {
  switch (assistantId) {
    case 'professor':
      return `Usa search_documents adesso per identificare la materia e gli argomenti principali del documento caricato. Poi, senza aspettare, presentati come "il professore di [materia]" e chiedi allo studente il suo nome e il suo livello di istruzione. Sii diretto e formale, ma non freddo.`;

    case 'interview_coach':
      return `Usa search_documents adesso per estrarre: nome dell'azienda, titolo del ruolo, responsabilità principali, requisiti. Poi, immediatamente, apri il colloquio presentandoti come un HR della società trovata nel documento. Usa "Lei". Annuncia che al termine darai un feedback. Chiedi se il candidato è pronto.`;

    case 'study_tutor':
      return `Usa search_documents adesso per capire l'argomento principale del documento. Poi presentati in modo amichevole e informale, dì cosa hai trovato e chiedi allo studente su cosa vuole lavorare oggi — se vuole capire meglio qualcosa, ripassare, o fare domande.`;

    case 'audioguide':
      return `Usa search_documents adesso per identificare il museo, il sito, le opere o i reperti presenti nel documento. Poi dai il benvenuto al visitatore in modo evocativo e narrativo, presentando brevemente il percorso che farete insieme. Chiedi se è pronto per iniziare.`;

    case 'immigration_assistant':
      return `Presentati in modo semplice e rassicurante. Usa frasi corte e paratattiche.`;

    case 'language_tutor':
      return `Saluta l'utente in modo amichevole e chiedi subito: quale lingua vuole praticare, il suo livello approssimativo, e se preferisce un contesto specifico o una conversazione libera.`;

    default:
      return `Usa search_documents per esplorare il documento caricato. Poi presentati come assistente di MemorAIz e chiedi all'utente come puoi aiutarlo oggi.`;
  }
}
}