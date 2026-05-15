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
//  When delta (cumulative - lastSwitchTokens) >= TOKEN_THRESHOLD:
//    → fire POST /api/voice/compact IMMEDIATELY (fire-and-forget, non-blocking)
//    → set compactionStateRef = 'EXTRACTING'
//    → record transcript index at extraction time (transcriptIndexAtExtractionRef)
//
//  When compact API returns:
//    → set compactionStateRef = 'READY', store result in pendingCompactResultRef
//
//  At next turnComplete (Gemini finishes speaking):
//    → atomically claim the switch (compactionStateRef = 'IDLE')
//    → compute volatile buffer = transcript.slice(transcriptIndexAtExtractionRef)
//    → POST /api/voice/token with { compactState, bufferTurns: volatileBuffer }
//    → lobotomise old WS (null out handlers), close it, open new WS
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
import { useRouter } from 'next/navigation';
import type { AnyAssistantState, SessionMode } from '@/src/services/contextManager/index';
import type { AssistantId } from '@/src/config/professorConfig';

// ── Constants ─────────────────────────────────────────────────────────────────

const GEMINI_WS_BASE =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService';

/** Build the correct WS URL depending on whether token is a raw API key or ephemeral token.
 *  Ephemeral tokens (name starts with 'auth_tokens/') MUST use:
 *    BidiGenerateContentConstrained + ?access_token=<name>  (no URL encoding)
 *  Regular API keys use:
 *    BidiGenerateContent + ?key=<apiKey>
 */
function buildWsUrl(token: string): string {
  if (token.startsWith('auth_tokens/')) {
    return `${GEMINI_WS_BASE}.BidiGenerateContentConstrained?access_token=${token}`;
  }
  return `${GEMINI_WS_BASE}.BidiGenerateContent?key=${encodeURIComponent(token)}`;
}

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
  /** Called at each turnComplete with the current cumulative input token count. */
  onTurnComplete?: (cumulativeInputTokens: number, deltaFromLastSwitch: number) => void;
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
    onTurnComplete,
  } = opts;

  const router = useRouter();

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

  // Token tracking — three refs, no redundancy
  // cumulative = historicalTokensRef + currentWsTokensRef (computed inline, never stored)
  // lastCompactionTokensRef is frozen at the EXACT moment threshold is crossed,
  // so delta restarts cleanly from 0 regardless of async switch latency.
  const historicalTokensRef = useRef<number>(0);      // total from all closed WS connections
  const currentWsTokensRef = useRef<number>(0);       // token count from the live WS
  const lastCompactionTokensRef = useRef<number>(0);  // snapshot taken at trigger time

  // Transcript (for compaction)
  const transcriptRef: MutableRefObject<TranscriptEntry[]> = useRef([]);
  const turnCounterRef = useRef<number>(0);

  // Compaction state machine ('IDLE' → 'EXTRACTING' → 'READY' → 'IDLE')
  const compactionStateRef = useRef<'IDLE' | 'EXTRACTING' | 'READY'>('IDLE');
  const pendingCompactResultRef = useRef<{ compactState: AnyAssistantState; lastTurnIndex: number } | null>(null);
  // Index into transcriptRef at the moment extraction fired — used to slice the volatile buffer at switch time.
  const transcriptIndexAtExtractionRef = useRef<number>(0);
  const baseSystemPromptRef = useRef<string>('');
  const currentStateRef = useRef<AnyAssistantState | null>(null);
  const lastExtractionTurnIndexRef = useRef<number>(-1); // lastTurnIndex from compact result, passed to next compact call
  const contextSwitchCountRef = useRef<number>(0);

  // Context-switch audio buffer (Phase 5)
  const isContextSwitchingRef = useRef<boolean>(false);
  const switchAudioBufferRef = useRef<Buffer[]>([]);
  const pendingMicByteRef = useRef<Buffer | null>(null); // for byte-alignment

  // Signals captured while wsRef is null during a context switch
  const pendingTurnCompleteRef = useRef<boolean>(false);

  // Set to true immediately after a context switch completes so the first
  // usageMetadata on the new WS re-baselines lastCompactionTokensRef to the
  // actual new-session token count (mirrors old onWebSocketSwitched logic).
  // Without this, the delta clock restarts from the OLD trigger baseline,
  // making the threshold re-trigger immediately after 1–2 exchanges → infinite loop.
  const justSwitchedRef = useRef<boolean>(false);

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
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      audioCtxRef.current = new AudioCtx({ sampleRate: PLAYBACK_SAMPLE_RATE });
      nextPlaybackTimeRef.current = 0;
    }
    // Force-resume if the browser auto-suspended it (requires user gesture context)
    if (audioCtxRef.current.state === 'suspended') {
      audioCtxRef.current.resume();
    }
    return audioCtxRef.current;
  }

  function playAudioChunk(base64Pcm: string): void {
    if (isContextSwitchingRef.current) return;
    if (Date.now() < ttsSuppressUntilRef.current) return;

    try {
      const raw = atob(base64Pcm);

      // Ensure even byte length — Int16Array requires it; odd buffers throw silently
      const safeLength = raw.length - (raw.length % 2);
      const bytes = new Uint8Array(safeLength);
      for (let i = 0; i < safeLength; i++) bytes[i] = raw.charCodeAt(i);

      // Int16 → Float32
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768;

      const ctx = ensureAudioContext();
      // ensureAudioContext already calls resume(), but be explicit here too
      if (ctx.state === 'suspended') ctx.resume();

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
    } catch (err) {
      console.error('[GeminiLive] Errore riproduzione audio:', err);
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
    onTranscript?.(role, trimmed);
  }

  // ── Context compaction (Phase 4) ─────────────────────────────────────────

  /**
   * Fire-and-forget LLM extraction.
   *
   * Called as soon as the token DELTA threshold is crossed (mid-turn, while the
   * user may still be speaking). Sets state = 'EXTRACTING' immediately so the
   * threshold check won't re-trigger. When the HTTP call returns, state becomes
   * 'READY' and the actual WS swap is deferred to the next turnComplete.
   *
   * The "volatile buffer" — turns that happen BETWEEN extraction start and the
   * switch — is computed at switch time by slicing transcriptRef from
   * transcriptIndexAtExtractionRef.current, so nothing needs to be accumulated.
   */
  function triggerCompaction(): void {
    if (compactionStateRef.current !== 'IDLE') return;

    console.log(
      `[GeminiLive] Token delta threshold reached (delta=${(historicalTokensRef.current + currentWsTokensRef.current) - lastCompactionTokensRef.current}, ` +
      `total=${historicalTokensRef.current + currentWsTokensRef.current}, lastCompaction=${lastCompactionTokensRef.current}, threshold=${TOKEN_THRESHOLD}). ` +
      `Will extract, then switch at next turnComplete.`,
    );
    compactionStateRef.current = 'EXTRACTING';
    transcriptIndexAtExtractionRef.current = transcriptRef.current.length;

    console.log(
      `[GeminiLive] Compaction triggered at delta=${(historicalTokensRef.current + currentWsTokensRef.current) - lastCompactionTokensRef.current} cumulative=${historicalTokensRef.current + currentWsTokensRef.current}`,
    );
    emitStatus('Compacting context...');

    fetch('/api/voice/compact', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        assistantId: assistantIdRef.current,
        sessionMode: sessionModeRef.current,
        transcript: [...transcriptRef.current],
        currentState: currentStateRef.current,
        lastExtractionTurnIndex: lastExtractionTurnIndexRef.current,
      }),
    })
      .then(async (res) => {
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(`Compact failed: ${error}`);
        }
        const result = await res.json() as { compactState: AnyAssistantState; lastTurnIndex: number };
        pendingCompactResultRef.current = result;
        compactionStateRef.current = 'READY';
        console.log('[GeminiLive] Extraction complete — will switch at next turnComplete.');
      })
      .catch((err) => {
        console.error('[GeminiLive] Compact error:', err instanceof Error ? err.message : err);
        compactionStateRef.current = 'IDLE'; // Allow retry at next threshold crossing
      });
  }

  // ── Tool call handling ───────────────────────────────────────────────────

  async function handleToolCalls(
    ws: WebSocket,
    calls: Array<{ id: string; name: string; args: Record<string, unknown> }>,
  ): Promise<void> {
    // ── Client-side navigation tool (intercept before backend calls) ─────
    const navCall = calls.find((c) => c.name === 'start_study_session');
    if (navCall) {
      const topic = String(navCall.args?.topic ?? '').trim();
      const durationMinutes = Number(navCall.args?.duration_minutes ?? 5);

      // Acknowledge the command to Gemini so it doesn't hang waiting for a response.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            toolResponse: {
              functionResponses: [
                {
                  id: navCall.id,
                  name: 'start_study_session',
                  response: { status: 'navigating' },
                },
              ],
            },
          }),
        );
      }

      // Navigate — the component will unmount and close the WS shortly after.
      router.push(
        `/study-session?topic=${encodeURIComponent(topic)}&duration=${durationMinutes}`,
      );
      return;
    }

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
      let hasResolved = false;
      const safeResolve = () => {
        if (!hasResolved) { hasResolved = true; resolve(); }
      };
      const safeReject = (err: Error) => {
        if (!hasResolved) { hasResolved = true; reject(err); }
      };

      const url = buildWsUrl(token);
      console.log('[GeminiLive] Tentativo di connessione a:', url.replace(token, 'TOKEN_OSCURATO'));
      const ws = new WebSocket(url);
      wsRef.current = ws;

      const timeout = setTimeout(() => {
        ws.close();
        console.error('[GeminiLive] Timeout connessione WS (15s)');
        safeReject(new Error('Gemini WS connection timeout. Google non ha risposto.'));
      }, 15000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log('[GeminiLive] WebSocket APERTO! Invio setup frame...');
        // Ephemeral tokens already encode model + constraints server-side.
        // Sending `model` here causes Google to reject with HTTP 400.
        ws.send(JSON.stringify({ setup: {} }));
      };

      ws.onmessage = async (event: MessageEvent) => {
        // Safely extract text regardless of whether Google sends Blob, ArrayBuffer, or String.
        // The Live API typically sends binary Blobs — event.data.toString() on a Blob
        // yields "[object Blob]" which breaks JSON.parse.
        let rawText = '';
        if (event.data instanceof Blob) {
          rawText = await event.data.text();
        } else if (event.data instanceof ArrayBuffer) {
          rawText = new TextDecoder().decode(event.data);
        } else {
          rawText = event.data;
        }

        console.log('[GeminiLive] Messaggio ricevuto (Testo):', rawText);

        let data: any;
        try {
          data = JSON.parse(rawText);
        } catch (e) {
          console.error('[GeminiLive] Fallito parsing JSON del messaggio:', e);
          return;
        }

        // ── Google API error frame ─────────────────────────────────────────
        if (data?.error) {
          const errMsg = data.error.message || JSON.stringify(data.error);
          console.error('[GeminiLive] ERRORE API da Google:', errMsg);
          safeReject(new Error(`Google API Error: ${errMsg}`));
          ws.close();
          return;
        }

        // ── Setup ACK / Session active ────────────────────────────────────
        // Resolve as soon as Google confirms: setupComplete, serverContent,
        // or an empty-object ACK (older API versions).
        const isSetupComplete =
          data?.setupComplete != null ||
          data?.setup_complete != null ||
          (data && Object.keys(data).length === 0);
        const hasServerContent =
          data?.serverContent != null ||
          data?.server_content != null;

        if (!hasResolved && (isSetupComplete || hasServerContent)) {
          console.log('[GeminiLive] Setup confermato/Sessione attiva. Sblocco UI.');
          reconnectAttemptsRef.current = 0;
          if (isSwitch) {
            // Transparent switch — status stays 'ready', no message to avoid confusing the user.
            console.log('[GeminiLive] Switch trasparente completato.');
          } else if (!isReconnectingRef.current) {
            setStatus('ready');
            emitStatus('Sessione avviata.');
          }
          // else: reconnect — status/message handled by handleUnexpectedClose after connectGemini returns.

          // Replay buffered mic audio to new session after a context switch.
          if (isSwitch && switchAudioBufferRef.current.length > 0) {
            console.log(`[GeminiLive] Replay di ${switchAudioBufferRef.current.length} chunk audio...`);
            // In MANUAL VAD mode the client must bracket audio with activityStart/End.
            // The activityEnd (or turnComplete) is sent below via the post-switch poke.
            ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
            for (const chunk of switchAudioBufferRef.current) {
              wsSendAudio(ws, chunk);
            }
            switchAudioBufferRef.current = [];
          }

          safeResolve();

          // Trigger the assistant to speak first on a fresh session.
          // Uses realtimeInput.text (same as old geminiSpeakFirst) so Gemini
          // treats it as a turn-start cue, not a user message in the transcript.
          if (!isSwitch && !isReconnectingRef.current) {
            setTimeout(() => {
              const activeWs = wsRef.current;
              if (activeWs && activeWs.readyState === WebSocket.OPEN) {
                activeWs.send(JSON.stringify({ realtimeInput: { text: 'Inizia la sessione ora.' } }));
              }
            }, 200);
          }
          // Do NOT return — continue processing audio/transcripts in this same frame
        }

        // ── Audio ──────────────────────────────────────────────────────────
        const audioPart = data?.serverContent?.modelTurn?.parts?.find(
          (p: any) => p?.inlineData?.mimeType?.startsWith('audio/pcm'),
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
          // Pick the first available field — do NOT sum them, they are aliases for
          // the same value (camelCase vs snake_case) or total-vs-prompt variants.
          // promptTokenCount is the input/context size, which is what matters for
          // the compaction threshold. Fall back to totalTokenCount if not present.
          const promptTokens =
            usage.promptTokenCount ??
            usage.prompt_token_count ??
            usage.totalTokenCount ??
            usage.total_token_count ??
            0;

          // current WS token count + accumulated historical = cumulative
          currentWsTokensRef.current = promptTokens;
          const cumulative = historicalTokensRef.current + promptTokens;

          // ── Post-switch re-baseline (mirrors old onWebSocketSwitched) ──────
          // The first usageMetadata on the new WS reveals the actual compressed-
          // context size.  Re-anchor lastCompactionTokensRef so the delta clock
          // starts from 0 here, not from the old pre-switch trigger value.
          // Without this, the compressed session (e.g. 4 k tokens) already sits
          // close to the 5 k threshold, and the FIRST exchange crosses it again
          // → extraction → switch → larger volatile buffer → same thing → ∞ loop.
          if (justSwitchedRef.current) {
            lastCompactionTokensRef.current = cumulative;
            justSwitchedRef.current = false;
            console.log(`[GeminiLive] Post-switch baseline set to ${cumulative} tokens (delta clock reset).`);
          }

          const delta = cumulative - lastCompactionTokensRef.current;
          if (delta >= TOKEN_THRESHOLD && compactionStateRef.current === 'IDLE') {
            // 🔒 FREEZE the threshold snapshot NOW — before any async work.
            // This makes delta restart from exactly 0 for the next cycle,
            // regardless of how long the LLM extraction + WS swap takes.
            lastCompactionTokensRef.current = cumulative;
            triggerCompaction();
          }
        }

        // ── Turn complete ──────────────────────────────────────────────────
        const turnComplete =
          data?.serverContent?.turnComplete === true ||
          data?.server_content?.turn_complete === true;

        if (turnComplete) {
          setSpeaking(false);
          const cumulative = historicalTokensRef.current + currentWsTokensRef.current;
          onTurnComplete?.(
            cumulative,
            cumulative - lastCompactionTokensRef.current,
          );

          // ── Context switch: only fires when extraction is READY ────────
          // Atomically claim the switch by resetting state before any await,
          // preventing a second turnComplete from starting a parallel switch.
          if (compactionStateRef.current === 'READY' && pendingCompactResultRef.current) {
            const { compactState, lastTurnIndex } = pendingCompactResultRef.current;
            compactionStateRef.current = 'IDLE';
            pendingCompactResultRef.current = null;

            // Volatile buffer: turns that happened while extraction was running.
            const volatileBuffer = transcriptRef.current
              .slice(transcriptIndexAtExtractionRef.current)
              .map(t => ({ role: t.role, text: t.text }));

            // Start buffering mic audio so nothing is lost during the async swap.
            isContextSwitchingRef.current = true;
            switchAudioBufferRef.current = [];

            // Anchor the historical baseline at the exact compaction trigger point.
            // Using += currentWsTokensRef would be wrong here: interrupted turns report
            // a lower promptTokenCount than the peak, making the post-switch cumulative
            // drop below lastCompactionTokensRef and producing a negative delta.
            // Using the frozen lastCompactionTokensRef guarantees delta restarts at ≥0.
            historicalTokensRef.current = lastCompactionTokensRef.current;
            currentWsTokensRef.current = 0;

            // Persist compact state for future extractions.
            currentStateRef.current = compactState;
            lastExtractionTurnIndexRef.current = lastTurnIndex;

            // 🔇 LOBOTOMISE THE OLD WS NOW — synchronously, before any await.
            // If we leave this until inside the async IIFE, the old WS can still
            // fire usageMetadata frames during the token-remint fetch.  Those
            // frames overwrite currentTokenCountRef (which we just zeroed) with
            // the old high count, making delta ≥ threshold again and re-triggering
            // compaction on every subsequent turn.
            const oldWs = wsRef.current;
            wsRef.current = null;
            if (oldWs) {
              oldWs.onclose = null;
              oldWs.onerror = null;
              oldWs.onmessage = null;
              if (oldWs.readyState !== WebSocket.CLOSED) {
                oldWs.close(1000, 'context-switch');
              }
            }

            console.log(
              `[GeminiLive] Context switch starting — volatile buffer: ${volatileBuffer.length} turns, ` +
              `historicalTokens=${historicalTokensRef.current}, lastCompaction=${lastCompactionTokensRef.current}`,
            );
            emitStatus('Context switch in progress...');

            // Run the async token-remint + reconnect without blocking the message loop.
            (async () => {
              try {
                const tokenRes = await fetch('/api/voice/token', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    assistantId: assistantIdRef.current,
                    sessionMode: sessionModeRef.current,
                    compactState,
                    bufferTurns: volatileBuffer,
                    baseSystemPrompt: baseSystemPromptRef.current,
                    documentConfigId: documentConfigIdRef.current,
                  }),
                });

                if (!tokenRes.ok) {
                  const { error } = await tokenRes.json().catch(() => ({ error: tokenRes.statusText }));
                  throw new Error(`Token remint failed: ${error}`);
                }

                const { token } = await tokenRes.json() as { token: string };

                await connectGemini(token, true);

                isContextSwitchingRef.current = false; // limbo ended
                justSwitchedRef.current = true; // re-baseline token delta on first new-WS usageMetadata

                // ── Post-switch poke ───────────────────────────────────────
                // If the user spoke or typed during the switch, the signals were
                // dropped (wsRef was null). Send them now so Gemini responds
                // instead of waiting in silence.
                const pokeWs = wsRef.current;
                if (pokeWs && pokeWs.readyState === WebSocket.OPEN) {
                  const lastMsg = transcriptRef.current[transcriptRef.current.length - 1];
                  const isLastMsgFromUser = lastMsg && lastMsg.role === 'user';

                  // 🚨 FIX "EFFETTO ECO":
                  // Facciamo il Poke SOLO se c'è un'interruzione VAD pendente
                  // E l'ultimo messaggio NON è già dell'utente.
                  // Se l'utente ha appena parlato, Gemini risponderà da solo!
                  const needsPoke = pendingTurnCompleteRef.current && !isLastMsgFromUser;

                  if (needsPoke) {
                    console.log('[GeminiLive] 🚨 Risveglio forzato (Poke) inviato per sbloccare il silenzio.');
                    pokeWs.send(JSON.stringify({ clientContent: { turnComplete: true } }));
                  }

                  // Resettiamo i flag
                  pendingTurnCompleteRef.current = false;
                }

                contextSwitchCountRef.current++;
                setContextSwitchCount(contextSwitchCountRef.current);
                onContextSwitch?.(contextSwitchCountRef.current);
                emitStatus(`Context switch #${contextSwitchCountRef.current} completato.`);
                console.log(`[GeminiLive] Context switch #${contextSwitchCountRef.current} complete. historical=${historicalTokensRef.current}, lastCompaction=${lastCompactionTokensRef.current}`);
              } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error('[GeminiLive] Context switch failed:', msg);
                emitStatus(`Context switch failed: ${msg}`);
                isContextSwitchingRef.current = false;
              }
            })();
          }
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
        clearTimeout(timeout);
        console.log(`[GeminiLive] WS CHIUSO. Code: ${event.code}, Reason: ${event.reason}`);

        // Ignore voluntary closure triggered by a context switch — the new WS is already open.
        if (event.reason === 'context-switch') {
          console.log('[GeminiLive] WS chiuso volontariamente per context switch. Nessuna riconnessione.');
          return;
        }

        if (intentionalCloseRef.current) {
          safeResolve();
          setStatus('ended');
          return;
        }

        // If closed before setupComplete, reject so the caller sees the error.
        if (!hasResolved) {
          safeReject(new Error(`Connection closed before setup: ${event.code} ${event.reason}`));
        }

        if (!isSwitch) {
          handleUnexpectedClose(event.code, event.reason);
        }
      };

      ws.onerror = (err) => {
        clearTimeout(timeout);
        console.error('[GeminiLive] WS ERRORE di rete:', err);
        safeReject(new Error('WebSocket network error'));
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
      setStatus('ready');
      emitStatus('Sessione riconnessa.');
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
        realtimeInput: {
          audio: {
            mimeType: 'audio/pcm',
            data: b64,
          },
        },
      }),
    );
  }

  // ── Activity signals (manual VAD mode) ──────────────────────────────────

  const signalSpeechStart = useCallback(() => {
    stopPlayback();
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const signalSpeechEnd = useCallback(() => {
    // If a context switch is in progress, wsRef is null — save the signal for
    // the post-switch poke so Gemini doesn't silently wait on the new WS.
    if (isContextSwitchingRef.current) {
      console.log('[GeminiLive] VAD activityEnd during switch limbo — queuing poke.');
      pendingTurnCompleteRef.current = true;
      return;
    }
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
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
        clientContent: {
          turns: [{ role: 'user', parts: [{ text: trimmed }] }],
          turnComplete: true,
        },
      }),
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Session lifecycle ────────────────────────────────────────────────────

  const startSession = useCallback(async (opts: SessionStartOptions = {}) => {
    // Unlock AudioContext synchronously inside the user-gesture handler (button click).
    // If called later (async), the browser may refuse to resume it.
    ensureAudioContext();

    intentionalCloseRef.current = false;
    reconnectAttemptsRef.current = 0;
    isReconnectingRef.current = false; // always reset from any previous session

    assistantIdRef.current = opts.assistantId ?? 'professor';
    documentConfigIdRef.current = opts.documentConfigId ?? null;
    sessionModeRef.current = undefined;

    // Reset state
    historicalTokensRef.current = 0;
    currentWsTokensRef.current = 0;
    lastCompactionTokensRef.current = 0;
    transcriptRef.current = [];
    turnCounterRef.current = 0;
    currentStateRef.current = null;
    lastExtractionTurnIndexRef.current = -1;
    compactionStateRef.current = 'IDLE';
    pendingCompactResultRef.current = null;
    transcriptIndexAtExtractionRef.current = 0;
    contextSwitchCountRef.current = 0;
    resumptionHandleRef.current = null;
    pendingMicByteRef.current = null;
    pendingTurnCompleteRef.current = false;
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
    compactionStateRef.current = 'IDLE';
    pendingCompactResultRef.current = null;

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
