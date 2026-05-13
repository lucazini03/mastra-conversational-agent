// hooks/useGeminiLive.ts
//
// Browser-side orchestrator for Gemini Live (serverless architecture).
//
// This hook replaces the entire stateful Node.js proxy (SessionHandler).
// The browser holds the direct WebSocket to Gemini and calls the serverless
// API routes for secure operations (token minting, RAG, compaction).
//
// ── Architecture overview ────────────────────────────────────────────────────
//
//  Browser
//    ├── Audio WS ←──→ Gemini Live (ephemeral token, direct connection)
//    │   Every Gemini frame is parsed here:
//    │     • audio chunks    → played via Web Audio API
//    │     • transcripts     → displayed in UI via callbacks
//    │     • usageMetadata   → token counting for compaction threshold
//    │     • toolCall        → paused, fetched via POST /api/voice/rag, resumed
//    │     • turnComplete    → triggers compaction switch if ready
//    │     • sessionResumption → handle stored for reconnect
//    │     • goAway          → pre-connects before forced disconnect
//    │
//    ├── POST /api/voice/token   (mints ephemeral token)
//    ├── POST /api/voice/rag     (secure RAG lookup)
//    └── POST /api/voice/compact (LLM extraction — fires preemptively)
//
// ── Preemptive Compaction (Phase 4) ─────────────────────────────────────────
//
//  When cumulativeInputTokens - lastSwitchTokens >= TOKEN_THRESHOLD:
//    → fire POST /api/voice/compact IMMEDIATELY (async, do not await)
//      (this runs the slow LLM extraction while the user is still speaking)
//    → store the promise in compactPromiseRef
//    → start buffering transcript turns in bufferTurnsRef
//
//  At the next turnComplete:
//    → await compactPromiseRef (usually already resolved)
//    → call POST /api/voice/token with { compactState, bufferTurns } to get new token
//    → do the WS swap (isContextSwitching = true, drain buffer, reconnect)
//
// ── Audio Buffer Drainer (Phase 5) ──────────────────────────────────────────
//
//  isContextSwitching = true during the WS swap window:
//    • All incoming audio from the browser mic is buffered (up to 256 KB)
//    • All incoming TTS audio from Gemini is discarded (old session)
//    • Buffered mic audio is replayed to the new WS after open
//    • isContextSwitching is cleared only AFTER the new setup ACK arrives
//
// ── VAD integration ──────────────────────────────────────────────────────────
//
//  Silero VAD (via @ricky0123/vad-web) runs in a separate AudioWorklet.
//  It fires onSpeechStart/onSpeechEnd and feeds mic frames to this hook.
//  The hook handles byte-alignment (16-bit PCM requires even-byte buffers)
//  and passes aligned Int16Arrays to the WebSocket.

'use client';

import {
  useRef,
  useCallback,
  useState,
  type MutableRefObject,
} from 'react';
import type { AnyAssistantState, SessionMode } from '@/src/services/contextManager/index';
import type { AssistantId } from '@/src/config/professorConfig';

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent';

const MIC_SAMPLE_RATE = 16000;
const PLAYBACK_SAMPLE_RATE = 24000;

/** Mirror of MEMORY_EXTRACTION_TOKEN_THRESHOLD env var (baked in at build time). */
const TOKEN_THRESHOLD = Number(process.env.NEXT_PUBLIC_TOKEN_THRESHOLD ?? 50000);

/** Maximum mic audio to buffer during a context switch (~8 s at 16kHz 16-bit mono). */
const MAX_SWITCH_BUFFER_BYTES = 256 * 1024;

/** How long to suppress TTS after a user interruption (ms). */
const TTS_SUPPRESSION_AFTER_INTERRUPTION_MS = 900;

/** Max consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_DELAY_MS = 1500;

// ── Public types ──────────────────────────────────────────────────────────────

export type TranscriptEntry = { role: 'user' | 'model'; text: string; turnIndex: number };

export type GeminiLiveStatus =
  | 'idle'
  | 'connecting'
  | 'ready'
  | 'switching'
  | 'reconnecting'
  | 'error'
  | 'ended';

export interface UseGeminiLiveOptions {
  /** Called for every status/log message (replaces sendJSON status). */
  onStatus?: (message: string) => void;
  /** Called for each transcript fragment as it arrives. */
  onTranscript?: (role: 'user' | 'model', text: string) => void;
  /** Called after a VAD event. */
  onVadEvent?: (source: 'silero' | 'gemini', message: string) => void;
  /** Called when Gemini's speaking state changes (for robot/soundbar animation). */
  onSpeakingChange?: (speaking: boolean) => void;
  /** Called after a successful context switch for debug display. */
  onContextSwitch?: (switchNumber: number) => void;
  /** Called with cost/token information when a session ends. */
  onCostSummary?: (summary: CostSummary) => void;
}

export interface SessionStartOptions {
  assistantId?: AssistantId;
  documentConfigId?: string;
}

export interface CostSummary {
  cumulativeInputTokens: number;
  contextSwitchCount: number;
}

export interface UseGeminiLiveReturn {
  status: GeminiLiveStatus;
  /** Start a new session. */
  startSession: (opts?: SessionStartOptions) => Promise<void>;
  /** Gracefully end the current session. */
  endSession: () => void;
  /** Send a text prompt (converted to realtime_input on the WS). */
  sendText: (text: string) => void;
  /** Feed a raw mic PCM chunk (Int16Array, 16kHz) from the VAD. */
  sendMicAudio: (samples: Int16Array) => void;
  /** Signal start of user speech turn (stops TTS + sends activityStart to Gemini). */
  signalSpeechStart: () => void;
  /** Signal end of user speech turn. */
  signalSpeechEnd: () => void;
  /** Immediately stop all TTS playback (e.g. on local VAD interruption). */
  stopPlayback: () => void;
  /** True while Gemini is speaking (drives UI animation). */
  isSpeaking: boolean;
  /** Number of context switches that have occurred. */
  contextSwitchCount: number;
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useGeminiLive(opts: UseGeminiLiveOptions = {}): UseGeminiLiveReturn {
  const {
    onStatus,
    onTranscript,
    onVadEvent,
    onSpeakingChange,
    onContextSwitch,
  } = opts;

  // ── React state (drives UI re-renders) ──────────────────────────────────
  const [status, setStatus] = useState<GeminiLiveStatus>('idle');
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [contextSwitchCount, setContextSwitchCount] = useState(0);

  // ── Refs (synchronous access inside WS message handlers) ────────────────

  // WebSocket + session
  const wsRef = useRef<WebSocket | null>(null);
  const modelRef = useRef<string>('');
  const assistantIdRef = useRef<AssistantId>('professor');
  const documentConfigIdRef = useRef<string | null>(null);
  const sessionModeRef = useRef<SessionMode | undefined>(undefined);
  const hasRagDocumentsRef = useRef<boolean>(false);
  const intentionalCloseRef = useRef<boolean>(false);

  // Resumption / reconnect
  const resumptionHandleRef = useRef<string | null>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  const isReconnectingRef = useRef<boolean>(false);

  // Token tracking
  const cumulativeInputTokensRef = useRef<number>(0);
  const lastSwitchTokenCountRef = useRef<number>(0);

  // Transcript (for compaction)
  const transcriptRef: MutableRefObject<TranscriptEntry[]> = useRef([]);
  const turnCounterRef = useRef<number>(0);

  // Compaction state machine
  const compactPromiseRef = useRef<Promise<{ compactState: AnyAssistantState; lastTurnIndex: number }> | null>(null);
  const newTokenForSwitchRef = useRef<string | null>(null);
  const baseSystemPromptRef = useRef<string>('');
  const currentStateRef = useRef<AnyAssistantState | null>(null);
  const lastExtractionTurnIndexRef = useRef<number>(-1);
  // Buffer turns: transcript entries accumulated AFTER extraction fires
  const isBufferingRef = useRef<boolean>(false);
  const bufferTurnsRef = useRef<Array<{ role: 'user' | 'model'; text: string }>>([]);
  const contextSwitchCountRef = useRef<number>(0);

  // Context-switch audio buffer (Phase 5)
  const isContextSwitchingRef = useRef<boolean>(false);
  const switchAudioBufferRef = useRef<Buffer[]>([]);
  const pendingMicByteRef = useRef<Buffer | null>(null); // for byte-alignment

  // Audio playback
  const audioCtxRef = useRef<AudioContext | null>(null);
  const nextPlaybackTimeRef = useRef<number>(0);
  const activeSourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());
  const ttsSuppressUntilRef = useRef<number>(0);

  // ── Internal helpers ─────────────────────────────────────────────────────

  const emitStatus = useCallback(
    (msg: string) => {
      onStatus?.(msg);
    },
    [onStatus],
  );

  const setSpeaking = useCallback(
    (val: boolean) => {
      setIsSpeaking(val);
      onSpeakingChange?.(val);
    },
    [onSpeakingChange],
  );

  // ── Audio playback ───────────────────────────────────────────────────────

  function ensureAudioContext(): AudioContext {
    if (!audioCtxRef.current || audioCtxRef.current.state === 'closed') {
      audioCtxRef.current = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
      nextPlaybackTimeRef.current = 0;
    }
    return audioCtxRef.current;
  }

  function playAudioChunk(base64Pcm: string): void {
    if (isContextSwitchingRef.current) return;
    if (Date.now() < ttsSuppressUntilRef.current) return;

    try {
      const raw = atob(base64Pcm);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      // Int16 → Float32
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

      const ctx = ensureAudioContext();
      const buffer = ctx.createBuffer(1, float32.length, PLAYBACK_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.connect(ctx.destination);

      const now = ctx.currentTime;
      const startAt = Math.max(now, nextPlaybackTimeRef.current);
      src.start(startAt);
      nextPlaybackTimeRef.current = startAt + buffer.duration;

      activeSourcesRef.current.add(src);
      src.onended = () => {
        activeSourcesRef.current.delete(src);
        if (activeSourcesRef.current.size === 0) {
          setSpeaking(false);
        }
      };

      setSpeaking(true);
    } catch {
      // Non-fatal
    }
  }

  const stopPlayback = useCallback((): void => {
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        // Already stopped
      }
    }
    activeSourcesRef.current.clear();
    nextPlaybackTimeRef.current = 0;
    setSpeaking(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Transcript tracking ──────────────────────────────────────────────────

  function addTranscriptEntry(role: 'user' | 'model', text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;

    turnCounterRef.current++;
    const entry: TranscriptEntry = { role, text: trimmed, turnIndex: turnCounterRef.current };
    transcriptRef.current.push(entry);

    // If extraction has started, track buffer turns
    if (isBufferingRef.current) {
      const last = bufferTurnsRef.current[bufferTurnsRef.current.length - 1];
      if (last && last.role === role) {
        last.text += ' ' + trimmed;
      } else {
        bufferTurnsRef.current.push({ role, text: trimmed });
      }
    }

    onTranscript?.(role, trimmed);
  }

  // ── Context compaction (Phase 4) ─────────────────────────────────────────

  /**
   * Stage 1: fire POST /api/voice/compact IMMEDIATELY (async).
   * Called as soon as the token threshold is crossed — mid-turn, while the
   * user is still speaking. This hides the LLM extraction latency.
   */
  function triggerCompaction(): void {
    if (compactPromiseRef.current) return; // already in flight

    const transcript = [...transcriptRef.current];
    const currentState = currentStateRef.current;
    const lastExtractionTurnIndex = lastExtractionTurnIndexRef.current;

    // Start accumulating buffer turns
    isBufferingRef.current = true;
    bufferTurnsRef.current = [];

    console.log(
      `[GeminiLive] Compaction triggered at ${cumulativeInputTokensRef.current} input tokens`,
    );
    emitStatus('Compacting context...');

    compactPromiseRef.current = fetch('/api/voice/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: assistantIdRef.current,
        sessionMode: sessionModeRef.current,
        transcript,
        currentState,
        lastExtractionTurnIndex,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(`Compact failed: ${error}`);
        }
        return res.json() as Promise<{ compactState: AnyAssistantState; lastTurnIndex: number }>;
      })
      .catch((err) => {
        console.error('[GeminiLive] Compact error:', err.message);
        // Clear so we can retry on the next threshold crossing
        compactPromiseRef.current = null;
        isBufferingRef.current = false;
        throw err;
      });
  }

  /**
   * Stage 2: called at every turnComplete. If compaction is done, executes
   * the WS swap. If compaction is still running, waits for it.
   *
   * The token remint (POST /api/voice/token with compactState + bufferTurns)
   * is chained immediately after compact resolves to minimise latency.
   */
  async function maybeDoContextSwitch(): Promise<void> {
    if (!compactPromiseRef.current) return;

    try {
      const { compactState, lastTurnIndex } = await compactPromiseRef.current;

      // Mint new token with assembled instruction (buffer turns now finalised).
      const tokenRes = await fetch('/api/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: assistantIdRef.current,
          sessionMode: sessionModeRef.current,
          compactState,
          bufferTurns: [...bufferTurnsRef.current],
          baseSystemPrompt: baseSystemPromptRef.current,
          documentConfigId: documentConfigIdRef.current,
        }),
      });

      if (!tokenRes.ok) {
        const { error } = await tokenRes.json().catch(() => ({ error: tokenRes.statusText }));
        throw new Error(`Token remint failed: ${error}`);
      }

      const { token } = await tokenRes.json() as { token: string };

      // ── Execute the WS swap ───────────────────────────────────────────
      isContextSwitchingRef.current = true;
      switchAudioBufferRef.current = [];
      setStatus('switching');
      emitStatus('Context switch in progress...');

      // Update compaction state
      currentStateRef.current = compactState;
      lastExtractionTurnIndexRef.current = lastTurnIndex;
      isBufferingRef.current = false;

      // Tear down old WS
      const oldWs = wsRef.current;
      wsRef.current = null;
      if (oldWs && oldWs.readyState !== WebSocket.CLOSED) {
        oldWs.close(1000, 'context-switch');
      }

      // Open new WS
      await connectGemini(token, true);

      // Update token accounting
      lastSwitchTokenCountRef.current = cumulativeInputTokensRef.current;
      compactPromiseRef.current = null;
      newTokenForSwitchRef.current = null;
      isContextSwitchingRef.current = false;

      contextSwitchCountRef.current++;
      setContextSwitchCount(contextSwitchCountRef.current);
      onContextSwitch?.(contextSwitchCountRef.current);
      emitStatus('Context switch complete.');
      console.log(`[GeminiLive] Context switch #${contextSwitchCountRef.current} complete`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeminiLive] Context switch failed:', msg);
      emitStatus(`Context switch failed: ${msg}`);
      compactPromiseRef.current = null;
      isContextSwitchingRef.current = false;
      isBufferingRef.current = false;
    }
  }

  // ── Tool call handling ───────────────────────────────────────────────────

  async function handleToolCalls(
    ws: WebSocket,
    calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  ): Promise<void> {
    const responses: Array<{ id: string; name: string; response: unknown }> = [];

    for (const call of calls) {
      if (call.name === 'search_documents') {
        const query = String(call.args?.query ?? '').trim();
        emitStatus(`RAG: "${query}"`);

        try {
          const res = await fetch('/api/voice/rag', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query,
              documentConfigId: documentConfigIdRef.current,
            }),
          });

          const ragResult = res.ok
            ? await res.json()
            : { relevantContext: '', sources: [], error: res.statusText };

          responses.push({
            id: call.id,
            name: call.name,
            response: {
              output: ragResult.relevantContext || 'No relevant content found.',
              sources: ragResult.sources ?? [],
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error('[GeminiLive] RAG error:', msg);
          responses.push({
            id: call.id,
            name: call.name,
            response: { output: 'Search failed — continue without document context.' },
          });
        }
      } else {
        // Unknown tool — return empty
        responses.push({ id: call.id, name: call.name, response: { output: '' } });
      }
    }

    // Send all responses back to Gemini in one frame.
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          tool_response: {
            function_responses: responses.map((r) => ({
              id: r.id,
              name: r.name,
              response: r.response,
            })),
          },
        }),
      );
    }
  }

  // ── Gemini WebSocket ─────────────────────────────────────────────────────

  /**
   * Opens a new Gemini Live WebSocket with the given ephemeral token.
   * If `isSwitch` is true, replays buffered mic audio after the setup ACK.
   */
  async function connectGemini(token: string, isSwitch = false): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${GEMINI_WS_BASE}?key=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Gemini WS connection timeout'));
      }, 15000);

      ws.onopen = () => {
        clearTimeout(timeout);

        // Send minimal setup — config is baked into the ephemeral token.
        ws.send(
          JSON.stringify({
            setup: {
              model: `models/${modelRef.current}`,
            },
          }),
        );

        // Connection opened; resolve once we get the setup ACK (first message).
      };

      ws.onmessage = (event: MessageEvent) => {
        let data: any;
        try {
          data = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
        } catch {
          return;
        }

        // ── Setup ACK ─────────────────────────────────────────────────────
        // Google sends a `setupComplete` message after setup. That's when the
        // session is truly ready. Resolve the promise here to continue.
        const isSetupComplete =
          data?.setupComplete != null ||
          data?.setup_complete != null ||
          // Older API versions just ACK with an empty object or serverContent
          (data && Object.keys(data).length === 0);

        if (isSetupComplete && !isReconnectingRef.current) {
          reconnectAttemptsRef.current = 0;
          setStatus('ready');
          emitStatus(isSwitch ? 'Sessione ripresa.' : 'Sessione avviata.');

          // Replay buffered mic audio to new session after a context switch.
          if (isSwitch && switchAudioBufferRef.current.length > 0) {
            for (const chunk of switchAudioBufferRef.current) {
              wsSendAudio(ws, chunk);
            }
            switchAudioBufferRef.current = [];
          }

          resolve();
        }

        // ── Audio ──────────────────────────────────────────────────────────
        const audioPart = data?.serverContent?.modelTurn?.parts?.find(
          (p: any) => p?.inlineData?.mimeType === 'audio/pcm',
        );
        if (audioPart?.inlineData?.data) {
          playAudioChunk(audioPart.inlineData.data);
        }

        // ── Transcripts ────────────────────────────────────────────────────
        const inputText = data?.serverContent?.inputTranscription?.text ?? data?.serverContent?.input_transcription?.text;
        if (inputText) addTranscriptEntry('user', inputText);

        const outputText = data?.serverContent?.outputTranscription?.text ?? data?.serverContent?.output_transcription?.text;
        if (outputText) addTranscriptEntry('model', outputText);

        // ── Usage metadata (token counting) ───────────────────────────────
        const usage = data?.usageMetadata ?? data?.usage_metadata;
        if (usage) {
          const promptTokens =
            (usage.promptTokenCount ?? 0) +
            (usage.prompt_token_count ?? 0) +
            (usage.totalTokenCount ?? 0); // some versions use totalTokenCount

          // Delta-based accumulation: Gemini reports cumulative prompt tokens
          // per session; we track delta-per-turn to avoid double-counting.
          // Actually usageMetadata is CUMULATIVE per session, so we just set:
          cumulativeInputTokensRef.current = Math.max(
            cumulativeInputTokensRef.current,
            promptTokens,
          );

          const delta = cumulativeInputTokensRef.current - lastSwitchTokenCountRef.current;
          if (delta >= TOKEN_THRESHOLD && !compactPromiseRef.current) {
            triggerCompaction();
          }
        }

        // ── Turn complete ──────────────────────────────────────────────────
        const turnComplete =
          data?.serverContent?.turnComplete === true ||
          data?.server_content?.turn_complete === true;

        if (turnComplete) {
          setSpeaking(false);
          // Stage 2 of compaction: if extraction is done, do the switch now.
          // This runs async — next mic input won't block on it.
          maybeDoContextSwitch().catch((e) =>
            console.error('[GeminiLive] maybeDoContextSwitch error:', e),
          );
        }

        // ── Tool calls ─────────────────────────────────────────────────────
        if (data?.toolCall?.functionCalls?.length > 0) {
          handleToolCalls(ws, data.toolCall.functionCalls).catch((e) =>
            console.error('[GeminiLive] Tool call error:', e),
          );
        }

        // ── Session resumption handle ─────────────────────────────────────
        const resumption =
          data?.sessionResumptionUpdate ??
          data?.session_resumption_update ??
          data?.sessionResumption?.update ??
          data?.session_resumption?.update;

        if (resumption) {
          const handle = resumption.handle ?? resumption.new_handle ?? resumption.newHandle;
          const resumable = resumption.resumable ?? true;
          if (handle && resumable) {
            resumptionHandleRef.current = handle;
          }
        }

        // ── goAway: Google will force-close shortly ────────────────────────
        if (data?.goAway || data?.go_away) {
          const timeLeft = data?.goAway?.timeLeft ?? data?.go_away?.time_left ?? 'unknown';
          console.warn(`[GeminiLive] goAway — closing in ${timeLeft}s. Handle ready: ${!!resumptionHandleRef.current}`);
        }

        // ── VAD interruption ──────────────────────────────────────────────
        if (data?.serverContent?.interrupted === true) {
          stopPlayback();
          ttsSuppressUntilRef.current = Date.now() + TTS_SUPPRESSION_AFTER_INTERRUPTION_MS;
          onVadEvent?.('gemini', 'Interruption detected (serverContent.interrupted=true).');
        }
      };

      ws.onclose = (event) => {
        if (intentionalCloseRef.current) {
          setStatus('ended');
          return;
        }

        if (!isSwitch) {
          // Unexpected close — attempt reconnect
          handleUnexpectedClose(event.code, event.reason);
        }
      };

      ws.onerror = (err) => {
        console.error('[GeminiLive] WS error:', err);
        if (!intentionalCloseRef.current && !isSwitch) {
          handleUnexpectedClose(0, 'WebSocket error');
        }
      };
    });
  }

  /** Reconnect using resumption handle (or fresh token on first failure). */
  async function handleUnexpectedClose(code: number, reason: string): Promise<void> {
    if (reconnectAttemptsRef.current >= MAX_RECONNECT_ATTEMPTS) {
      setStatus('error');
      emitStatus(`Connection lost after ${MAX_RECONNECT_ATTEMPTS} attempts (${code} ${reason}).`);
      return;
    }

    reconnectAttemptsRef.current++;
    isReconnectingRef.current = true;
    setStatus('reconnecting');
    emitStatus(`Disconnected (${code}). Reconnecting (${reconnectAttemptsRef.current}/${MAX_RECONNECT_ATTEMPTS})...`);

    await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));

    try {
      const tokenRes = await fetch('/api/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: assistantIdRef.current,
          documentConfigId: documentConfigIdRef.current,
          resumptionHandle: resumptionHandleRef.current,
        }),
      });

      if (!tokenRes.ok) throw new Error(`Token refresh failed: ${tokenRes.statusText}`);
      const { token } = await tokenRes.json();

      await connectGemini(token, false);
      isReconnectingRef.current = false;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[GeminiLive] Reconnect failed:', msg);
      isReconnectingRef.current = false;
      handleUnexpectedClose(0, 'reconnect failed');
    }
  }

  // ── Mic audio sending ────────────────────────────────────────────────────

  /** Byte-align and send a PCM chunk to Gemini, buffering during switches. */
  function sendMicAudio(samples: Int16Array): void {
    if (isReconnectingRef.current) return;

    // Convert Int16Array to Buffer for alignment logic
    let decoded = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);

    // Reattach any dangling byte from the previous chunk
    if (pendingMicByteRef.current) {
      decoded = Buffer.concat([pendingMicByteRef.current, decoded]);
      pendingMicByteRef.current = null;
    }

    // Ensure even byte length (16-bit PCM must be 2-byte aligned)
    let aligned = decoded;
    if (decoded.byteLength % 2 !== 0) {
      pendingMicByteRef.current = decoded.slice(decoded.byteLength - 1);
      aligned = decoded.slice(0, decoded.byteLength - 1);
    }

    if (aligned.byteLength === 0) return;

    // During context switch: buffer mic audio (replayed to new WS after open)
    if (isContextSwitchingRef.current) {
      const total = switchAudioBufferRef.current.reduce((s, b) => s + b.byteLength, 0);
      if (total < MAX_SWITCH_BUFFER_BYTES) {
        switchAudioBufferRef.current.push(aligned);
      }
      return;
    }

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    wsSendAudio(ws, aligned);
  }

  function wsSendAudio(ws: WebSocket, pcmBuffer: Buffer): void {
    const b64 = pcmBuffer.toString('base64');
    ws.send(
      JSON.stringify({
        realtime_input: {
          media_chunks: [{ mime_type: 'audio/pcm', data: b64 }],
        },
      }),
    );
  }

  // ── Activity signals (manual VAD mode) ──────────────────────────────────

  const signalSpeechStart = useCallback(() => {
    stopPlayback();
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ realtime_input: { activityStart: {} } }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signalSpeechEnd = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ realtime_input: { activityEnd: {} } }));
  }, []);

  // ── Text prompt ──────────────────────────────────────────────────────────

  const sendText = useCallback((text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    addTranscriptEntry('user', trimmed);

    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      emitStatus('Not connected — text message dropped.');
      return;
    }

    ws.send(
      JSON.stringify({
        client_content: {
          turns: [{ role: 'user', parts: [{ text: trimmed }] }],
          turn_complete: true,
        },
      }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session lifecycle ────────────────────────────────────────────────────

  const startSession = useCallback(async (opts: SessionStartOptions = {}) => {
    intentionalCloseRef.current = false;
    reconnectAttemptsRef.current = 0;

    assistantIdRef.current = opts.assistantId ?? 'professor';
    documentConfigIdRef.current = opts.documentConfigId ?? null;
    sessionModeRef.current = undefined;

    // Reset state
    cumulativeInputTokensRef.current = 0;
    lastSwitchTokenCountRef.current = 0;
    transcriptRef.current = [];
    turnCounterRef.current = 0;
    currentStateRef.current = null;
    lastExtractionTurnIndexRef.current = -1;
    compactPromiseRef.current = null;
    isBufferingRef.current = false;
    bufferTurnsRef.current = [];
    contextSwitchCountRef.current = 0;
    resumptionHandleRef.current = null;
    pendingMicByteRef.current = null;
    setContextSwitchCount(0);

    setStatus('connecting');
    emitStatus('Requesting session token...');

    try {
      const tokenRes = await fetch('/api/voice/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          assistantId: assistantIdRef.current,
          documentConfigId: documentConfigIdRef.current,
        }),
      });

      if (!tokenRes.ok) {
        const { error } = await tokenRes.json().catch(() => ({ error: tokenRes.statusText }));
        throw new Error(error ?? 'Token request failed');
      }

      const tokenData = await tokenRes.json() as {
        token: string;
        model: string;
        hasRagDocuments: boolean;
        baseSystemPrompt: string;
        initialState?: AnyAssistantState;
      };

      modelRef.current = tokenData.model;
      hasRagDocumentsRef.current = tokenData.hasRagDocuments;
      baseSystemPromptRef.current = tokenData.baseSystemPrompt;
      sessionModeRef.current = tokenData.hasRagDocuments ? 'RAG' : 'FREE_ROAM';

      if (tokenData.initialState) {
        currentStateRef.current = tokenData.initialState;
      }

      emitStatus('Connecting to Gemini Live...');
      await connectGemini(tokenData.token, false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus('error');
      emitStatus(`Failed to start session: ${msg}`);
      throw err;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const endSession = useCallback(() => {
    intentionalCloseRef.current = true;
    compactPromiseRef.current = null;
    isBufferingRef.current = false;

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      ws.close(1000, 'user-ended');
    }

    stopPlayback();
    setStatus('ended');
    emitStatus('Session ended.');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    startSession,
    endSession,
    sendText,
    sendMicAudio,
    signalSpeechStart,
    signalSpeechEnd,
    stopPlayback,
    isSpeaking,
    contextSwitchCount,
  };
}
