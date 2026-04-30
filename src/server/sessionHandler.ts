// src/server/sessionHandler.ts
//
// One instance of this class is created per browser WebSocket connection.
// It owns an InterviewAgent and pipes audio in both directions:
//   Browser mic PCM → GeminiLive → Browser speaker PCM
//
// Protocol (all text frames, JSON):
//   Browser → Server  { type: 'start_session', documentConfigId?: string, demoId?: string, practiceContext?: object }
//   Browser → Server  { type: 'end_session' }
//   Browser → Server  { type: 'audio_chunk', data: string }   ← base64 Int16 PCM, 16kHz mono
//   Browser → Server  { type: 'text_prompt', text: string }
//   Browser → Server  { type: 'language_spoken', language: string }  ← CIAO demo_4: hint for translator
//   Browser → Server  { type: 'initiate_practice', transcript: Array<{role,text}>, difficulty: string }
//   Browser → Server  { type: 'initiate_feedback', demoId: string, transcript: Array<{role,text}>, difficulty: string }
//   Server  → Browser { type: 'transcript', role: 'user'|'model', text: string }
//   Server  → Browser { type: 'vad_event', source: 'silero'|'gemini', message: string }
//   Server  → Browser { type: 'status',     message: string }
//   Server  → Browser { type: 'error',      message: string }
//   Server  → Browser { type: 'tts_audio',  data: string }    ← base64 Int16 PCM, 24kHz mono
//   Server  → Browser { type: 'interview_feedback', markdown: string }
//   Server  → Browser { type: 'practice_ready', context: object }
//   Server  → Browser { type: 'feedback_ready', context: object, reviewDemoId: string }

import { WebSocket, type RawData } from 'ws';
import { rm } from 'node:fs/promises';
import { generateText, generateObject } from 'ai';
import { z } from 'zod';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createInterviewAgent, type InterviewAgent } from '../agent/agentFactory.js';
import {
  DEFAULT_ASSISTANT_ID,
  INTERVIEW_COACH_PROMPT,
  CIAO_DEMO_LABELS,
  CIAO_DEMO_OPENING_PROMPTS,
  getDemoPrompt,
  isCiaoAssistantId,
  type AssistantId,
  type CiaoAssistantId,
  type AnyDemoId,
  type DemoPromptOptions,
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
  private selectedAssistantId: AnyDemoId = DEFAULT_ASSISTANT_ID;
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

  // Stored practice context: set when initiate_practice extraction succeeds;
  // consumed once on the next start_session('demo_4_practice') call.
  private pendingPracticeContext: unknown | null = null;

  // Stored feedback context: set when initiate_feedback extraction succeeds;
  // consumed once on the next start_session('demo_N_review') call.
  private pendingFeedbackContext: unknown | null = null;

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
      demoId?: string;
      language?: string;
      transcript?: Array<{ role: string; text: string }>;
      difficulty?: string;
      practiceContext?: unknown;
      feedbackContext?: unknown;
    };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[${this.sessionId}] Non-JSON control message:`, raw);
      return;
    }

    switch (msg.type) {
      case 'start_session': {
        const rawDemoId = typeof msg.demoId === 'string' ? msg.demoId.trim() : '';
        this.selectedAssistantId = isCiaoAssistantId(rawDemoId)
          ? rawDemoId
          : DEFAULT_ASSISTANT_ID;
        // Client may pass back a practice context extracted in a prior session.
        if (msg.practiceContext !== undefined) {
          this.pendingPracticeContext = msg.practiceContext;
        }
        // Client may pass back a feedback context extracted in a prior session.
        if (msg.feedbackContext !== undefined) {
          this.pendingFeedbackContext = msg.feedbackContext;
        }
        await this.startSession(msg.documentConfigId);
        break;
      }
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
      case 'language_spoken': {
        // CIAO demo_4: informational hint about which language button was pressed.
        // The system prompt drives translation behaviour; this is logged for diagnostics.
        const lang = String(msg.language ?? 'unknown');
        console.log(`[${this.sessionId}] language_spoken hint: ${lang}`);
        break;
      }
      case 'initiate_practice': {
        await this.handleInitiatePractice(
          msg.transcript ?? [],
          (msg.difficulty as 'easy' | 'medium' | 'hard' | undefined) ?? 'easy',
        );
        break;
      }
      case 'initiate_feedback': {
        const reviewDemoId = typeof msg.demoId === 'string' ? `${msg.demoId}_review` : '';
        await this.handleInitiateFeedback(
          msg.transcript ?? [],
          (msg.difficulty as 'easy' | 'medium' | 'hard' | undefined) ?? 'easy',
          reviewDemoId,
        );
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

    // ── CIAO demos: use the demo-specific system prompt, no doc upload needed ──
    const isCiaoDemo = isCiaoAssistantId(this.selectedAssistantId);

    // Consume any stored practice context (set by initiate_practice flow).
    const practiceOpts: DemoPromptOptions = {};
    if (this.selectedAssistantId === 'demo_4_practice' && this.pendingPracticeContext) {
      practiceOpts.practiceContextJSON = this.pendingPracticeContext;
      this.pendingPracticeContext = null;
    }
    // Consume any stored feedback context (set by initiate_feedback flow).
    if (
      (this.selectedAssistantId === 'demo_1_review' ||
        this.selectedAssistantId === 'demo_2_review' ||
        this.selectedAssistantId === 'demo_3_review') &&
      this.pendingFeedbackContext
    ) {
      practiceOpts.feedbackContextJSON = this.pendingFeedbackContext;
      this.pendingFeedbackContext = null;
    }

    const contextFiles = uploadConfig?.contextFiles ?? [];
    let instructions = isCiaoDemo
      ? getDemoPrompt(this.selectedAssistantId as CiaoAssistantId, undefined, practiceOpts)
      : INTERVIEW_COACH_PROMPT;
    const initialState: AnyAssistantState = {
      behavioral_directives: [],
      user_language: '',
      candidate_info: { name: '', background: '' },
      current_phase: 'introduction',
      questions_asked: [],
      overall_impression: '',
    } as AnyAssistantState;

    if (!isCiaoDemo && contextFiles.length > 0) {
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
      // ContextManager's assistantId drives schema selection for memory compaction.
      // CIAO demos reuse the interview_coach schema (generic state shape).
      assistantId: isCiaoAssistantId(this.selectedAssistantId)
        ? DEFAULT_ASSISTANT_ID
        : (this.selectedAssistantId as AssistantId),
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
    // Feedback generation only applies to the interview coach demo.
    if (isCiaoAssistantId(this.selectedAssistantId)) return;
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

  private getAssistantLabel(assistantId: AnyDemoId): string {
    if (isCiaoAssistantId(assistantId)) {
      return CIAO_DEMO_LABELS[assistantId];
    }
    return 'Interview Coach';
  }

  private getOpeningPrompt(assistantId: AnyDemoId): string {
    if (isCiaoAssistantId(assistantId)) {
      return CIAO_DEMO_OPENING_PROMPTS[assistantId];
    }
    const roleTitle = this.interviewStructure?.role_title ?? 'the position';
    return `Greet the candidate warmly, introduce yourself as their interviewer for the ${roleTitle} role, and ask only for their name to get started. Do not ask what role they are applying for.`;
  }

  // ─── Practice Session Extraction ────────────────────────────────────────────
  //
  // Called when the browser sends { type: 'initiate_practice' }.
  // Uses gemini-2.0-flash-lite (cheap text model) + generateObject to turn the
  // raw transcript array into a structured PracticeContext JSON, then sends it
  // back to the client.  The client re-sends it as practiceContext on the next
  // start_session message so the new Gemini Live WS can be seeded with it.

  private async handleInitiatePractice(
    rawTranscript: Array<{ role: string; text: string }>,
    difficulty: 'easy' | 'medium' | 'hard',
  ): Promise<void> {
    if (rawTranscript.length === 0) {
      this.sendJSON({
        type: 'error',
        message: 'Nessun trascritto disponibile per la sessione di pratica.',
      });
      return;
    }

    this.sendStatus('Preparing practice session...');
    console.log(`[${this.sessionId}] Extracting practice context from ${rawTranscript.length} transcript lines...`);

    const apiKey = process.env.GEMINI_LLM_API_KEY;
    if (!apiKey) {
      this.sendJSON({ type: 'error', message: 'API key not configured.' });
      return;
    }
    const model = process.env.MEMORY_EXTRACTION_MODEL ?? 'gemini-2.0-flash-lite';

    const PracticeContextSchema = z.object({
      scenario_summary: z.string().describe('A brief summary of what the conversation was about.'),
      key_vocabulary: z
        .array(
          z.object({
            italian: z.string(),
            native_language: z.string(),
          }),
        )
        .describe('3-5 key words or short phrases used in the conversation.'),
      turns: z
        .array(
          z.object({
            speaker: z.enum(['migrant', 'italian_speaker']),
            intent: z.string().describe('What the speaker was trying to achieve.'),
            italian_phrase: z.string().describe('The correct Italian phrase for this turn.'),
            native_phrase: z
              .string()
              .describe("The translation of the phrase in the migrant's native language."),
          }),
        )
        .describe('The chronological turns of the conversation.'),
    });

    const transcriptText = rawTranscript
      .map(t => `[${t.role === 'user' ? 'MIGRANT' : 'TRANSLATOR'}]: ${t.text}`)
      .join('\n');

    const nativeLang = process.env.USER_NATIVE_LANGUAGE?.trim() || 'English';

    try {
      const google = createGoogleGenerativeAI({ apiKey });
      const { object } = await generateObject({
        model: google(model),
        schema: PracticeContextSchema,
        prompt: `You are a language-learning assistant. The following is a translation session transcript between a migrant (native language: ${nativeLang}) and an Italian speaker, mediated by a real-time translator.

Extract the key information from this conversation to prepare a structured practice exercise that will help the migrant learn to say these phrases in Italian themselves.

TRANSCRIPT:
${transcriptText}

Extract the scenario summary, 3-5 key vocabulary items, and the conversation turns. For each turn, identify who was speaking (migrant or italian_speaker), their communicative intent, the correct Italian phrase, and its translation in ${nativeLang}.`,
      });

      this.pendingPracticeContext = object;

      console.log(`[${this.sessionId}] Practice context extracted: ${object.turns.length} turns, ${object.key_vocabulary.length} vocab items.`);

      this.sendJSON({
        type: 'practice_ready',
        context: object,
        difficulty,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Practice extraction failed:`, message);
      this.sendJSON({
        type: 'error',
        message: `Practice session preparation failed: ${message}`,
      });
    }
  }

  // ─── Feedback Session Extraction ─────────────────────────────────────────────
  //
  // Called when the browser sends { type: 'initiate_feedback' }.
  // Uses the LLM model + generateObject to extract a structured FeedbackContext
  // from the session transcript, then sends it back to the client as
  // { type: 'feedback_ready' }.  The client closes the current WS and opens
  // a new one (demoId: 'demo_N_review') passing back the context.

  private async handleInitiateFeedback(
    rawTranscript: Array<{ role: string; text: string }>,
    difficulty: 'easy' | 'medium' | 'hard',
    reviewDemoId: string,
  ): Promise<void> {
    if (rawTranscript.length === 0) {
      this.sendJSON({
        type: 'error',
        message: 'Nessun trascritto disponibile per il feedback.',
      });
      return;
    }

    this.sendStatus('Preparing feedback...');
    console.log(`[${this.sessionId}] Extracting feedback context from ${rawTranscript.length} transcript lines (review: ${reviewDemoId})...`);

    const apiKey = process.env.GEMINI_LLM_API_KEY;
    if (!apiKey) {
      this.sendJSON({ type: 'error', message: 'API key not configured.' });
      return;
    }
    const model = process.env.MEMORY_EXTRACTION_MODEL ?? 'gemini-2.0-flash-lite';

    const FeedbackContextSchema = z.object({
      overall_praise: z
        .string()
        .describe('A warm, positive summary of how the user did in the session. Must be encouraging.'),
      phrases_to_practice: z
        .array(
          z.object({
            user_attempt: z
              .string()
              .describe('What the user actually said (including mistakes or their native language).'),
            correct_italian: z
              .string()
              .describe('The correct, natural, and simple Italian phrasing.'),
            reason: z
              .string()
              .describe('Very brief reason for the correction.'),
          }),
        )
        .max(3)
        .describe('1 to 3 specific phrases the user struggled with and needs to practice.'),
    });

    const transcriptText = rawTranscript
      .map(t => `[${t.role === 'user' ? 'LEARNER' : 'AI TUTOR'}]: ${t.text}`)
      .join('\n');

    const nativeLang = process.env.USER_NATIVE_LANGUAGE?.trim() || 'English';

    try {
      const google = createGoogleGenerativeAI({ apiKey });
      const { object } = await generateObject({
        model: google(model),
        schema: FeedbackContextSchema,
        prompt: `You are a language-learning analyst. The following is a transcript of an Italian language practice session between a migrant learner (native language: ${nativeLang}) and an AI tutor.

Your task: extract a structured feedback object to be delivered in a follow-up session.

TRANSCRIPT:
${transcriptText}

Provide:
1. An "overall_praise" — a warm, encouraging summary of what the user did well. Be genuine and specific to what happened in the session.
2. "phrases_to_practice" — at most 3 phrases where the user made a notable mistake (wrong verb conjugation, used their native language instead of Italian, wrong word order, etc.). For each, record exactly what they said, the correct Italian form, and a very brief explanation. Prioritize the most instructive errors.`,
      });

      this.pendingFeedbackContext = object;

      console.log(`[${this.sessionId}] Feedback context extracted: ${object.phrases_to_practice.length} phrases to practice.`);

      this.sendJSON({
        type: 'feedback_ready',
        context: object,
        reviewDemoId,
        difficulty,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Feedback extraction failed:`, message);
      this.sendJSON({
        type: 'error',
        message: `Feedback preparation failed: ${message}`,
      });
    }
  }
}