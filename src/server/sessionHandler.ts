// src/server/sessionHandler.ts
//
// One instance of this class is created per browser WebSocket connection.
// It owns an InterviewAgent and pipes audio in both directions:
//   Browser mic PCM → GeminiLive → Browser speaker PCM
//
// Protocol (all text frames, JSON):
//   Browser → Server  { type: 'start_session', documentConfigId?: string }
//   Browser → Server  { type: 'end_session' }
//   Browser → Server  { type: 'audio_chunk', data: string }   ← base64 Int16 PCM, 16kHz mono
//   Browser → Server  { type: 'text_prompt', text: string }
//   Server  → Browser { type: 'transcript', role: 'user'|'model', text: string }
//   Server  → Browser { type: 'vad_event', source: 'silero'|'gemini', message: string }
//   Server  → Browser { type: 'status',     message: string }
//   Server  → Browser { type: 'error',      message: string }
//   Server  → Browser { type: 'tts_audio',  data: string }    ← base64 Int16 PCM, 24kHz mono
//   Server  → Browser { type: 'interview_feedback', markdown: string }

import { WebSocket, type RawData } from 'ws';
import { rm } from 'node:fs/promises';
import { generateText } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createInterviewAgent, type InterviewAgent } from '../agent/agentFactory.js';
import {
  DEFAULT_ASSISTANT_ID,
  INTERVIEW_COACH_PROMPT,
  type AssistantId,
} from '../config/interviewConfig.js';
import { documentService, type InterviewStructure } from './documentService.js';
import { SessionCostTracker } from './sessionCostTracker.js';
import { SessionLogger } from './sessionLogger.js';
import {
  ContextManager,
  generateMarkdownSummary,
  type InjectionPayload,
  type AnyAssistantState,
} from '../services/contextManager/index.js';
import { appendSessionToLog } from './usageTracker.js';
import type { UploadedDocumentConfig } from './documentConfigStore.js';

const RECONNECT_DELAY_MS = 1500;

const MAX_RECONNECT_ATTEMPTS = 5;

type SessionHandlerDeps = {
  consumeDocumentConfig: (configId: string) => Promise<UploadedDocumentConfig | null>;
};

export class SessionHandler {
  private ws: WebSocket;
  private agent: InterviewAgent | null = null;
  private sessionId: string;
  private isStarting = false;
  private pendingMicByte: Buffer | null = null;
  private pendingTtsByte: Buffer | null = null;
  private pendingTextPrompts: string[] = [];
  private pendingAudioChunks: Buffer[] = [];
  private isContextSwitching = false;
  private costTracker = new SessionCostTracker();
  private sessionCostSummarySent = false;
  private selectedAssistantId: AssistantId = DEFAULT_ASSISTANT_ID;
  private uploadedDocumentDir: string | null = null;
  private readonly deps: SessionHandlerDeps;

  private jobDescriptionText: string | null = null;
  private interviewStructure: InterviewStructure | null = null;
  private transcriptLines: Array<{ role: 'user' | 'model'; text: string }> = [];
  private feedbackSent = false;

  private enrichedInstructions: string | null = null;

  private contextManager: ContextManager | null = null;

  private sessionLogger: SessionLogger | null = null;

  private resumptionHandle: string | null = null;
  private reconnectAttempts = 0;
  private isReconnecting = false;
  private isUserActive = false;
  private intentionalClose = false;

  private geminiWs: WebSocket | null = null;
  private geminiWsMessageListener: ((data: RawData) => void) | null = null;

  constructor(ws: WebSocket, sessionId: string, deps: SessionHandlerDeps) {
    this.ws = ws;
    this.sessionId = sessionId;
    this.deps = deps;
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
    let msg: {
      type: string;
      data?: string;
      text?: string;
      documentConfigId?: string;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[${this.sessionId}] Non-JSON control message:`, raw);
      return;
    }

    switch (msg.type) {
      case 'start_session':
        this.selectedAssistantId = DEFAULT_ASSISTANT_ID;
        await this.startSession(msg.documentConfigId);
        break;
      case 'end_session':
        this.intentionalClose = true;
        await this.generateAndSendFeedback();
        await this.cleanup();
        if (this.ws.readyState === WebSocket.OPEN) this.ws.close();
        break;
      case 'simulate_disconnect':
        if (this.geminiWs) {
          console.log(`[${this.sessionId}] Simulating Google disconnect...`);
          this.geminiWs.emit('error', new Error('Simulated Google WebSocket closure'));
          this.geminiWs.terminate();
        }
        break;
      case 'audio_chunk':
        if (!msg.data || !this.agent) break;
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

          // Buffer audio during a context switch so that any speech the user
          // uttered to interrupt the assistant isn't silently discarded when
          // the old WS is torn down. The buffered PCM is replayed to the new
          // WS after the swap (see flushPendingAudioChunks).
          if (this.isContextSwitching) {
            const MAX_BUFFERED_BYTES = 256 * 1024; // ~8 s at 16 kHz 16-bit mono
            const bufferedTotal = this.pendingAudioChunks.reduce((s, b) => s + b.byteLength, 0);
            if (bufferedTotal < MAX_BUFFERED_BYTES) {
              this.pendingAudioChunks.push(aligned);
            }
            break;
          }

          try {
            const int16 = new Int16Array(aligned.buffer, aligned.byteOffset, aligned.byteLength / 2);
            await this.agent.voice.send(int16);
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

        if (this.isReconnecting || this.isContextSwitching || !this.agent) {
          this.pendingTextPrompts.push(text);
          this.sendStatus('Message queued — will be sent when the connection is ready.');
          break;
        }

        const sent = this.sendRealtimeText(this.agent.voice, text);
        if (!sent) {
          this.pendingTextPrompts.push(text);
          if (!this.intentionalClose) {
            this.scheduleReconnect();
          }
        }
        break;
      }
      case 'activity_start': {
        this.isUserActive = true;
        const geminiWs = this.geminiWs;
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
        }
        break;
      }
      case 'activity_end': {
        this.isUserActive = false;
        const geminiWs = this.geminiWs;
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
          geminiWs.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
        }
        break;
      }
      default:
        console.warn(`[${this.sessionId}] Unknown message type: ${msg.type}`);
    }
  }

  // ─── Session Lifecycle ──────────────────────────────────────────────────────

  private async startSession(documentConfigId?: string) {
    if (this.agent || this.isStarting) {
      this.sendStatus('Session already active');
      return;
    }

    const uploadConfig = await this.resolveUploadConfig(documentConfigId);
    if (documentConfigId && !uploadConfig) {
      this.sendJSON({
        type: 'error',
        message: 'Document selection expired. Please re-upload the file and restart the session.',
      });
      return;
    }

    this.uploadedDocumentDir = uploadConfig?.uploadDir ?? null;

    this.intentionalClose = false;
    this.reconnectAttempts = 0;
    this.costTracker.reset();
    this.sessionCostSummarySent = false;
    this.transcriptLines = [];
    this.feedbackSent = false;
    this.jobDescriptionText = null;

    const contextFiles = uploadConfig?.contextFiles ?? [];
    let instructions = INTERVIEW_COACH_PROMPT;
    const initialState: AnyAssistantState = {
      behavioral_directives: [],
      user_language: '',
      candidate_info: { name: '', background: '' },
      current_phase: 'introduction',
      questions_asked: [],
      overall_impression: '',
    } as AnyAssistantState;

    if (contextFiles.length > 0) {
      try {
        const docs = await documentService.getDocumentsHashAndText(contextFiles);
        if (docs.text.trim().length > 0) {
          this.jobDescriptionText = docs.text;

          const structureResult = await documentService.generateInterviewStructure(docs.text);
          if (structureResult.structure) {
            this.interviewStructure = structureResult.structure;
            instructions =
              INTERVIEW_COACH_PROMPT +
              `\n\n## Job Description\n\n${docs.text}\n\n## Interview Plan\n\n${JSON.stringify(structureResult.structure, null, 2)}`;
          } else {
            instructions = INTERVIEW_COACH_PROMPT + `\n\n## Job Description\n\n${docs.text}`;
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.sessionId}] Failed to load job description: ${message}`);
      }
    }

    const markdown = generateMarkdownSummary(initialState);
    instructions += '\n\n---\n' + markdown;

    this.enrichedInstructions = instructions;

    this.contextManager = new ContextManager({
      sessionId: this.sessionId,
      assistantId: this.selectedAssistantId,
      baseSystemPrompt: instructions,
    });
    this.contextManager.setInitialState(initialState);
    this.contextManager.on('switchReady', (payload) => this.handleContextSwitch(payload));
    this.contextManager.on('extractionUsage', (inputTokens, outputTokens) => {
      this.costTracker.recordExtractionUsage(inputTokens, outputTokens);
    });

    this.sessionLogger = new SessionLogger(this.sessionId, this.selectedAssistantId);

    await this.connectToGemini(false);
  }

  private async connectToGemini(isReconnect: boolean) {
    if (this.isStarting) return;
    this.isStarting = true;

    let createdAgent: InterviewAgent | null = null;

    try {
      if (!isReconnect) {
        this.sendStatus(`Connecting to ${this.getAssistantLabel(this.selectedAssistantId)}...`);
      }

      const instructions = this.enrichedInstructions ?? INTERVIEW_COACH_PROMPT;
      createdAgent = createInterviewAgent({
        instructions,
        name: this.getAssistantLabel(this.selectedAssistantId),
      });
      const { voice } = createdAgent;

      const reconnectWithHandle = isReconnect && !!this.resumptionHandle;

      this.patchSetupEvent(voice, reconnectWithHandle ? (this.resumptionHandle ?? undefined) : undefined);

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

      voice.on('writing', ({ text, role }: { text: string; role: string }) => {
        this.sendJSON({ type: 'transcript', role, text });
        console.log(`[${this.sessionId}] ${role}: ${text}`);
        if (role === 'user' || role === 'model') {
          this.contextManager?.addTranscriptEntry(role, text);
          this.transcriptLines.push({ role, text });
        }
        this.sessionLogger?.addTranscriptLine(role === 'user' ? 'user' : 'model', text);
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

      await voice.connect();

      if (this.isUserActive) {
        const gWs = this.getGeminiWebSocket(voice);
        if (gWs && gWs.readyState === WebSocket.OPEN) {
          gWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
          console.log(`[${this.sessionId}] Restored activityStart on new WS (user was active).`);
        }
      }

      this.attachGeminiMessageSpy(voice);

      const oldAgent = this.agent;
      this.agent = createdAgent;
      createdAgent = null;

      if (oldAgent) {
        oldAgent.destroy().catch(() => {});
      }

      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.sessionLogger?.startEpisode(
        isReconnect ? 'reconnect' : 'initial_connection',
        this.costTracker.getFullTokenSnapshot(),
      );

      this.flushPendingTextPrompts(voice);

      if (!isReconnect) {
        this.sendStatus(`Connected! ${this.getAssistantLabel(this.selectedAssistantId)} is ready.`);
        this.geminiSpeakFirst(voice, this.getOpeningPrompt(this.selectedAssistantId));
      } else {
        if (reconnectWithHandle) {
          this.sendStatus('Connection restored.');
          console.log(`[${this.sessionId}] Session resumed transparently (attempt ${this.reconnectAttempts + 1})`);
        } else {
          this.sendStatus('Connection restored (context may not be fully preserved).');
          console.warn(`[${this.sessionId}] Reconnected without resumption handle: context continuity not guaranteed.`);
        }
      }

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Failed to connect (reconnect=${isReconnect}):`, message);

      if (createdAgent) {
        await createdAgent.destroy();
      }

      if (isReconnect && !this.intentionalClose) {
        this.scheduleReconnect();
      } else if (!isReconnect) {
        this.sendStatus(`Connection failed: ${message}`);
        this.sendJSON({ type: 'error', message: `Failed to connect: ${message}` });
        this.agent = null;
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
      this.sendJSON({ type: 'error', message: 'Unable to restore connection. Please reload the page.' });
      this.cleanup();
      return;
    }

    this.isReconnecting = true;
    console.log(`[${this.sessionId}] Scheduling reconnect attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${RECONNECT_DELAY_MS}ms`);
    this.sendStatus('Reconnecting...');

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

  // ─── Context Compaction: WebSocket Switch ────────────────────────────────────
  //
  // When the ContextManager determines that:
  //   1. An extraction succeeded (compact state is ready), AND
  //   2. The current WebSocket has been alive longer than WEBSOCKET_SWITCH_TIME_MS
  // …it emits `switchReady` with the full injection payload. We then:
  //   - Create a new GeminiLiveVoice with the enriched system_instruction.
  //   - Swap it in atomically (same pattern as reconnect).
  //   - Clear the ContextManager's buffers.

  private async handleContextSwitch(payload: InjectionPayload): Promise<void> {
    if (this.isStarting || this.isReconnecting || this.intentionalClose) return;

    console.log(
      `[${this.sessionId}] Context switch: injecting compact state + buffer (${payload.unprocessedBuffer.length} chars) into new WebSocket.`,
    );
    // Record the compact state against the outgoing episode before the new one opens.
    this.sessionLogger?.recordCompactState(payload.compactState, payload.extractionModel);
    this.sendStatus('Optimizing memory...');

    await this.connectToGeminiWithContext(payload);
  }

  /**
   * Similar to connectToGemini(isReconnect=true) but injects the ContextManager's
   * combined system instruction (base prompt + compact state + volatile buffer)
   * into the new connection's setup event.
   */
  private async connectToGeminiWithContext(payload: InjectionPayload): Promise<void> {
    if (this.isStarting) return;
    this.isStarting = true;
    this.isContextSwitching = true;

    let createdAgent: InterviewAgent | null = null;

    try {
      createdAgent = createInterviewAgent({
        instructions: payload.systemInstruction,
        name: this.getAssistantLabel(this.selectedAssistantId),
      });
      const { voice } = createdAgent;

      // Disable automatic VAD on the new context-switch connection.
      // (No resumption handle — context switch deliberately starts a fresh session.)
      this.patchSetupEvent(voice);

      // Inject resumption handle if available (preserves audio state).
      // if (this.resumptionHandle) {
      //   const handle = this.resumptionHandle;
      //   const anyVoice = voice as any;
      //   if (typeof anyVoice.sendEvent === 'function') {
      //     const originalSendEvent = anyVoice.sendEvent.bind(anyVoice);
      //     anyVoice.sendEvent = (type: string, data: any) => {
      //       if (type === 'setup' && data?.setup) {
      //         this.withSessionResumption(data, handle);
      //         console.log(`[${this.sessionId}] Context switch: injecting resumption handle ${handle.slice(0, 12)}...`);
      //       }
      //       return originalSendEvent(type, data);
      //     };
      //   }
      // }

      // INTENTIONALLY no resumptionHandle injection here.
// connectToGeminiWithContext is the deliberate context-compaction path:
// its entire purpose is to shed the old session's token history and start
// a clean new WebSocket backed only by the compact state in the system
// instruction. Injecting a resumptionHandle would tell Google to restore
// the full prior session — negating all cost savings AND creating a
// "double memory" conflict (native history vs. injected compact state)
// that causes the model to repeat its last output.
// resumptionHandle is only used in connectToGemini(isReconnect=true) for
// unexpected disconnects where we want continuity, not cost reduction.

      // Re-wire audio, transcripts, error handling — same as connectToGemini.
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
        audioStream.on('end', () => { this.pendingTtsByte = null; });
      });

      voice.on('writing', ({ text, role }: { text: string; role: string }) => {
        this.sendJSON({ type: 'transcript', role, text });
        if (role === 'user' || role === 'model') {
          this.contextManager?.addTranscriptEntry(role, text);
          this.transcriptLines.push({ role, text });
        }
        this.sessionLogger?.addTranscriptLine(role === 'user' ? 'user' : 'model', text);
      });

      voice.on('toolCall', ({ name, args, id }: { name: string; args: unknown; id: string }) => {
        console.log(`[${this.sessionId}] Tool call: ${name} (id=${id})`, args);
      });

      voice.on('error', (err: { message: string; code?: string }) => {
        console.warn(`[${this.sessionId}] Voice error after context switch [${err.code ?? 'unknown'}]:`, err.message);
        if (!this.intentionalClose) this.scheduleReconnect();
      });

      await voice.connect();

      // If the user was speaking when this new WS was established (reconnect or
      // context switch), immediately signal activityStart so Gemini knows a turn
      // is in progress and doesn't discard the incoming audio.
      if (this.isUserActive) {
        const gWs = this.getGeminiWebSocket(voice);
        if (gWs && gWs.readyState === WebSocket.OPEN) {
          gWs.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
          console.log(`[${this.sessionId}] Restored activityStart on new WS (user was active).`);
        }
      }

      this.attachGeminiMessageSpy(voice);

      const oldAgent = this.agent;
      this.agent = createdAgent;
      createdAgent = null;

      if (oldAgent) {
        oldAgent.destroy().catch(() => {});
      }

      this.reconnectAttempts = 0;
      this.isReconnecting = false;
      this.isContextSwitching = false;

      // Replay any audio/text that arrived while the old WS was being torn down
      // (e.g. the user interrupted the assistant right at the switch boundary).
      await this.flushPendingAudioChunks(voice);
      this.flushPendingTextPrompts(voice);

      // Tell ContextManager the switch succeeded — snapshot token count for delta threshold.
      const snap = this.costTracker.getInputTokenSnapshot();
      this.contextManager?.onWebSocketSwitched(snap.inputText + snap.inputAudio);
      // Open the new log episode (this also closes the outgoing episode with the same snapshot).
      this.sessionLogger?.startEpisode('context_switch', this.costTracker.getFullTokenSnapshot());

      this.sendStatus('Memory optimized. Conversation continues.');
      console.log(`[${this.sessionId}] Context switch completed successfully.`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Context switch failed:`, message);
      if (createdAgent) {
        await createdAgent.destroy();
      }
      // Discard buffered audio — the old WS is still alive so audio will
      // resume normally from the next chunk.
      this.pendingAudioChunks = [];
      // Fallback: keep the current connection alive — don't crash the session.
    } finally {
      this.isStarting = false;
      this.isContextSwitching = false;
    }
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
        if (data?.serverContent?.interrupted === true) { // GEMINI VAD interruption (gemini heard )
          console.warn(`[${this.sessionId}] VAD interruption detected`);
          this.sendJSON({
            type: 'vad_event',
            source: 'gemini',
            message: 'Interruzione rilevata dal VAD di Gemini (serverContent.interrupted=true).',
          });
        }

        // ── Context Compaction: detect turnComplete & feed token usage ────
        const turnComplete =
          data?.serverContent?.turnComplete === true ||
          data?.server_content?.turn_complete === true;
        if (turnComplete && this.contextManager) {
          // Feed latest token snapshot to ContextManager for threshold check.
          this.contextManager.checkTokenThreshold(this.costTracker.getInputTokenSnapshot());
          this.contextManager.onTurnComplete();
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

  private async flushPendingAudioChunks(voice: any) {
    if (this.pendingAudioChunks.length === 0) return;
    const chunks = this.pendingAudioChunks.splice(0);
    const combined = Buffer.concat(chunks);
    if (combined.byteLength < 2) return;
    // Ensure even byte length for Int16Array
    const usable = combined.byteLength % 2 === 0 ? combined : combined.slice(0, combined.byteLength - 1);
    try {
      const int16 = new Int16Array(usable.buffer, usable.byteOffset, usable.byteLength / 2);
      await voice.send(int16);
      console.log(`[${this.sessionId}] Flushed ${usable.byteLength} buffered audio bytes to new WS after context switch.`);
    } catch (err) {
      console.warn(`[${this.sessionId}] flushPendingAudioChunks failed:`, err instanceof Error ? err.message : String(err));
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
    this.contextManager?.addTranscriptEntry(role, text);
    // Audio transcriptions are the primary transcript source in voice mode.
    this.sessionLogger?.addTranscriptLine(role, text);
    // Capture for end-of-session feedback generation.
    this.transcriptLines.push({ role, text });
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

  /**
   * Patches the voice instance's sendEvent so that every 'setup' message sent
   * to Gemini includes:
   *   - realtimeInputConfig.automaticActivityDetection.disabled = true
   *   - optionally a session resumption handle
   */
  private patchSetupEvent(voice: any, resumptionHandle?: string) {
    const anyVoice = voice as any;
    if (typeof anyVoice.sendEvent !== 'function') return;

    const originalSendEvent = anyVoice.sendEvent.bind(anyVoice);
    anyVoice.sendEvent = (type: string, data: any) => {
      if (type === 'setup' && data?.setup) {
        // Disable Gemini's automatic VAD — we drive turns from Silero in the browser.
        data.setup.realtimeInputConfig = {
          ...(data.setup.realtimeInputConfig ?? {}),
          automaticActivityDetection: { disabled: true },
        };
        // Inject resumption handle if provided (reconnect path only).
        if (resumptionHandle) {
          this.withSessionResumption(data, resumptionHandle);
          console.log(
            `[${this.sessionId}] Setup patch: resumption handle injected (${resumptionHandle.slice(0, 12)}...)`,
          );
        }
      }
      return originalSendEvent(type, data);
    };
  }

  private withSessionResumption(data: any, handle: string) {
    if (!data?.setup) return;

    // Keep both variants for compatibility with SDK/API field naming.
    data.setup.session_resumption = { handle };
    data.setup.sessionResumption = { handle };
  }


  private async cleanup() {
    // ── Session file log ───────────────────────────────────────────────────
    // Close the current episode with a final token snapshot and trigger async
    // file write. We null-out the reference immediately so no new data is added
    // after finalization, then await the write at the very end of cleanup.
    const finalTokenSnap = this.costTracker.getFullTokenSnapshot();
    this.sessionLogger?.closeCurrentEpisode(finalTokenSnap);
    const { summary: finalCostSummary, sessionMinutes: finalSessionMinutes } = this.costTracker.getSummary();
    const sessionLogPromise = this.sessionLogger?.finalizeSession(finalCostSummary) ?? Promise.resolve();
    this.sessionLogger = null;

    this.emitSessionCostSummary();

    appendSessionToLog(this.sessionId, finalCostSummary, finalSessionMinutes).catch((err) => {
      console.error(`[${this.sessionId}] Failed to write usage_tracking.log: ${err instanceof Error ? err.message : String(err)}`);
    });

    this.pendingMicByte = null;
    this.pendingTtsByte = null;
    this.pendingTextPrompts = [];
    this.pendingAudioChunks = [];
    this.isReconnecting = false;
    this.isContextSwitching = false;
    this.isUserActive = false;

    if (this.contextManager) {
      this.contextManager.removeAllListeners();
      this.contextManager = null;
    }

    if (this.geminiWs && this.geminiWsMessageListener) {
      this.geminiWs.off('message', this.geminiWsMessageListener);
      this.geminiWsMessageListener = null;
      this.geminiWs = null;
    }

    if (this.agent) {
      await this.agent.destroy();
      this.agent = null;
      console.log(`[${this.sessionId}] Interview agent destroyed`);
    }

    if (this.uploadedDocumentDir) {
      try {
        await rm(this.uploadedDocumentDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup of temporary uploads.
      }
      this.uploadedDocumentDir = null;
    }

    await sessionLogPromise;
  }

  private async resolveUploadConfig(
    documentConfigId?: string,
  ): Promise<UploadedDocumentConfig | null> {
    const normalizedId = documentConfigId?.trim();
    if (!normalizedId) return null;
    return this.deps.consumeDocumentConfig(normalizedId);
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
      `[${this.sessionId}] Doc Summary Generation: input=${summary.summaryInputTokens.toLocaleString()}, output=${summary.summaryOutputTokens.toLocaleString()} ` +
        `(${summary.summaryCostUsd === null ? 'N/A' : `$${summary.summaryCostUsd.toFixed(6)}`}) [0 = served from cache]`,
    );
    console.log(
      `[${this.sessionId}] Context-Switch Extractions (${summary.extractionCount}): input=${summary.extractionInputTokens.toLocaleString()}, output=${summary.extractionOutputTokens.toLocaleString()} ` +
        `(${summary.extractionCostUsd === null ? 'N/A' : `$${summary.extractionCostUsd.toFixed(6)}`})`,
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

  private async generateAndSendFeedback(): Promise<void> {
    if (this.feedbackSent || this.transcriptLines.length === 0) return;
    this.feedbackSent = true;

    const transcript = this.transcriptLines
      .map((l) => `${l.role === 'user' ? 'Candidate' : 'Interviewer'}: ${l.text}`)
      .join('\n');

    const jdSection = this.jobDescriptionText
      ? `\n\n## Job Description\n\n${this.jobDescriptionText}`
      : '';

    const prompt = `You are an expert interview coach. Analyze the following interview transcript and provide a structured feedback report in Markdown format.${jdSection}\n\n## Interview Transcript\n\n${transcript}\n\nWrite a concise feedback report with these sections:\n1. Overall Assessment\n2. Strengths\n3. Areas for Improvement\n4. Key Recommendation`;

    try {
      const google = createGoogleGenerativeAI({
        apiKey: process.env.GEMINI_LLM_API_KEY ?? process.env.GEMINI_LIVE_API_KEY ?? '',
      });
      const { text: markdown } = await generateText({
        model: google('gemini-3.1-flash-lite-preview'),
        prompt,
      });
      this.sendJSON({ type: 'interview_feedback', markdown });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] generateAndSendFeedback failed:`, message);
    }
  }

  private sendJSON(obj: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private sendStatus(message: string) {
    this.sendJSON({ type: 'status', message });
  }

  private getAssistantLabel(_assistantId: AssistantId): string {
    return 'Interview Coach';
  }

  private getOpeningPrompt(_assistantId: AssistantId): string {
    const roleTitle = this.interviewStructure?.role_title ?? 'the position';
    return `Greet the candidate warmly, introduce yourself as their interviewer for the ${roleTitle} role, and ask only for their name to get started. Do not ask what role they are applying for.`;
  }
}