'use client';
// app/page.tsx
//
// Professor-focused landing page for MemorAIz.
// Documents are OPTIONAL — no upload → free-roam mode.
// VAD scripts are loaded after hydration; the start button is always clickable
// and shows a clear error if VAD isn't ready yet.
// A collapsible debug panel replaces the old server terminal.

import { useState, useRef, useEffect, useCallback, useReducer } from 'react';
import Script from 'next/script';
import { useGeminiLive } from '@/hooks/useGeminiLive';

// ── Constants ─────────────────────────────────────────────────────────────────

const SILERO_POSITIVE_SPEECH_THRESHOLD = 0.9;
const SILERO_NEGATIVE_SPEECH_THRESHOLD = 0.4;
const SILERO_MIN_SPEECH_MS = 180;

function float32ToInt16(float: Float32Array): Int16Array {
  const out = new Int16Array(float.length);
  for (let i = 0; i < float.length; i++) {
    const s = Math.max(-1, Math.min(1, float[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function formatDuration(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function nowLabel(): string {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

// ── Debug log ─────────────────────────────────────────────────────────────────

type LogType = 'status' | 'transcript-user' | 'transcript-model' | 'vad' | 'rag' | 'switch' | 'error';

interface LogEntry {
  id: number;
  ts: string;
  type: LogType;
  text: string;
}

let _logId = 0;

function logReducer(state: LogEntry[], action: LogEntry): LogEntry[] {
  // Keep last 300 entries to avoid memory leak
  const next = [...state, action];
  return next.length > 300 ? next.slice(next.length - 300) : next;
}

const LOG_COLORS: Record<LogType, string> = {
  status: '#94a3b8',
  'transcript-user': '#38bdf8',
  'transcript-model': '#7cf9cc',
  vad: '#fb923c',
  rag: '#c084fc',
  switch: '#facc15',
  error: '#f87171',
};

const LOG_LABELS: Record<LogType, string> = {
  status: 'STATUS',
  'transcript-user': 'USER',
  'transcript-model': 'AI',
  vad: 'VAD',
  rag: 'RAG',
  switch: 'SWITCH',
  error: 'ERROR',
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  // ── State ──────────────────────────────────────────────────────────────
  const [statusText, setStatusText] = useState('Pronto');
  const [sessionTimer, setSessionTimer] = useState('00:00');
  const [summaryFileName, setSummaryFileName] = useState('Nessun file selezionato');
  const [ragFileName, setRagFileName] = useState('Nessun file selezionato');
  const [chatValue, setChatValue] = useState('');
  const [sessionActive, setSessionActive] = useState(false);
  const [vadReady, setVadReady] = useState(false);

  // Debug panel
  const [logs, addLogEntry] = useReducer(logReducer, [] as LogEntry[]);
  const [showDebug, setShowDebug] = useState(false);
  const debugEndRef = useRef<HTMLDivElement>(null);

  // ── Helpers ─────────────────────────────────────────────────────────────
  const addLog = useCallback((type: LogType, text: string) => {
    addLogEntry({ id: ++_logId, ts: nowLabel(), type, text });
  }, []);

  // Auto-scroll debug panel
  useEffect(() => {
    if (showDebug) {
      debugEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [logs, showDebug]);

  // ── Refs ────────────────────────────────────────────────────────────────
  const summaryInputRef = useRef<HTMLInputElement>(null);
  const ragInputRef = useRef<HTMLInputElement>(null);
  const timerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionStartAtRef = useRef<number | null>(null);
  const vadRef = useRef<unknown>(null);
  const vadActiveRef = useRef<boolean>(false);
  const prerollFramesRef = useRef<Int16Array[]>([]);
  const prerollBytesRef = useRef<number>(0);
  const MAX_PREROLL_BYTES = Math.floor((16000 * 2 * 280) / 1000);

  // ── useGeminiLive hook ──────────────────────────────────────────────────
  const gemini = useGeminiLive({
    onStatus: (msg) => {
      setStatusText(msg);
      addLog('status', msg);
    },
    onTranscript: (role, text) => {
      addLog(role === 'user' ? 'transcript-user' : 'transcript-model', text);
    },
    onVadEvent: (source, message) => {
      addLog('vad', `[${source.toUpperCase()}] ${message}`);
    },
    onContextSwitch: (n) => {
      addLog('switch', `Context switch #${n} completato.`);
      setStatusText(`Context switch #${n} completato.`);
    },
    onTurnComplete: (cumulative, delta) => {
      addLog('status', `[tokens] cumulative=${cumulative.toLocaleString()} | delta_from_last_switch=${delta.toLocaleString()}`);
    },
  });

  const { status, isSpeaking, startSession, endSession, sendText, sendMicAudio, signalSpeechStart, signalSpeechEnd, stopPlayback } = gemini;

  // ── Session timer ────────────────────────────────────────────────────────
  function startTimer() {
    sessionStartAtRef.current = Date.now();
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = setInterval(() => {
      if (sessionStartAtRef.current === null) return;
      setSessionTimer(formatDuration(Date.now() - sessionStartAtRef.current));
    }, 1000);
  }

  function stopTimer() {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    timerIntervalRef.current = null;
    sessionStartAtRef.current = null;
    setSessionTimer('00:00');
  }

  // ── File upload (optional) ────────────────────────────────────────────────
  async function uploadDocuments(): Promise<{ documentConfigId: string | null }> {
    const summaryFile = summaryInputRef.current?.files?.[0] ?? null;
    const ragFiles = ragInputRef.current?.files
      ? Array.from(ragInputRef.current.files)
      : [];

    // No files → free roam, skip upload entirely
    if (!summaryFile && ragFiles.length === 0) {
      addLog('status', 'Nessun documento caricato — modalità FREE ROAM.');
      return { documentConfigId: null };
    }

    const names = [summaryFile?.name, ...ragFiles.map((f) => f.name)].filter(Boolean).join(', ');
    addLog('status', `Caricamento documenti: ${names}`);

    const form = new FormData();
    if (summaryFile) form.append('summaryDocument', summaryFile);
    ragFiles.forEach((f) => form.append('ragDocuments', f));

    const res = await fetch('/api/document-config', { method: 'POST', body: form });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload?.error ?? `Upload failed (${res.status})`);
    }
    const data = await res.json();
    addLog('status', `Documenti caricati. ID: ${data.documentConfigId} — RAG: ${data.effectiveRagCount} file`);
    return { documentConfigId: data.documentConfigId ?? null };
  }

  // ── VAD ─────────────────────────────────────────────────────────────────

  function resetPreroll() {
    prerollFramesRef.current = [];
    prerollBytesRef.current = 0;
  }

  function pushPreroll(frame: Int16Array) {
    const copy = frame.slice();
    prerollFramesRef.current.push(copy);
    prerollBytesRef.current += copy.byteLength;
    while (prerollBytesRef.current > MAX_PREROLL_BYTES && prerollFramesRef.current.length > 0) {
      const dropped = prerollFramesRef.current.shift()!;
      prerollBytesRef.current -= dropped.byteLength;
    }
  }

  function flushPreroll() {
    for (const frame of prerollFramesRef.current) {
      sendMicAudio(frame);
    }
    resetPreroll();
  }

  const stopVad = useCallback(async () => {
    vadActiveRef.current = false;
    resetPreroll();
    if (vadRef.current) {
      try {
        await (vadRef.current as any).destroy();
      } catch {
        // ignore
      }
      vadRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startVad = useCallback(async () => {
    const w = window as any;
    if (!w.vad?.MicVAD) {
      addLog('error', 'MicVAD runtime non caricato — VAD disabilitato. La sessione continua senza rilevamento automatico della voce.');
      return; // Non-fatal: session continues, user can use text input
    }

    vadRef.current = await w.vad.MicVAD.new({
      model: 'legacy',
      startOnLoad: false,
      baseAssetPath: '/',
      onnxWASMBasePath: '/',
      positiveSpeechThreshold: SILERO_POSITIVE_SPEECH_THRESHOLD,
      negativeSpeechThreshold: SILERO_NEGATIVE_SPEECH_THRESHOLD,
      minSpeechMs: SILERO_MIN_SPEECH_MS,
      preSpeechPadMs: 160,
      redemptionMs: 900,
      onSpeechRealStart: () => {
        vadActiveRef.current = true;
        stopPlayback();
        signalSpeechStart();
        flushPreroll();
      },
      onSpeechEnd: () => {
        vadActiveRef.current = false;
        signalSpeechEnd();
        resetPreroll();
      },
      onFrameProcessed: (_probs: unknown, audioFrame: Float32Array) => {
        const int16 = float32ToInt16(audioFrame);
        if (vadActiveRef.current) {
          sendMicAudio(int16);
        } else {
          pushPreroll(int16);
        }
      },
    });
    await (vadRef.current as any).start();
    addLog('status', 'VAD Silero avviato.');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMicAudio, signalSpeechStart, signalSpeechEnd, stopPlayback, addLog]);

  // ── Start / stop ──────────────────────────────────────────────────────────

  async function handleStart() {
    if (sessionActive) return;

    addLog('status', '── Nuova sessione ──────────────────');
    setStatusText('Preparazione documenti...');

    try {
      const { documentConfigId } = await uploadDocuments();

      setStatusText('Connessione a Gemini...');
      addLog('status', 'Richiesta token ephemeral...');
      await startSession({ assistantId: 'professor', documentConfigId: documentConfigId ?? undefined });

      setSessionActive(true);
      startTimer();

      await startVad();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      addLog('error', msg);
      setStatusText(`Errore: ${msg}`);
      setSessionActive(false);
      stopTimer();
    }
  }

  function handleStop() {
    void stopVad();
    endSession();
    setSessionActive(false);
    stopTimer();
    addLog('status', '── Sessione terminata ──────────────');
    setStatusText('Sessione terminata.');
  }

  function handleSend() {
    if (!chatValue.trim() || status !== 'ready') return;
    sendText(chatValue);
    setChatValue('');
  }

  // ── Sync hook status ──────────────────────────────────────────────────────
  useEffect(() => {
    if (status === 'ready' && !sessionActive) {
      setSessionActive(true);
    }
    if (status === 'error' || status === 'ended') {
      setSessionActive(false);
      stopTimer();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // ── Cleanup on unmount ────────────────────────────────────────────────────
  useEffect(() => {
    return () => {
      void stopVad();
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isConnected = status === 'ready';

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <link rel="stylesheet" href="/index.css" />

      {/*
        VAD scripts: afterInteractive fires onLoad reliably in App Router.
        The start button is NOT gated on these — if VAD isn't loaded when the
        user clicks start, we log a warning and continue without VAD.
      */}
      <Script src="/ort.min.js" strategy="afterInteractive" />
      <Script
        src="/vad.bundle.min.js"
        strategy="afterInteractive"
        onLoad={() => {
          setVadReady(true);
          addLog('status', 'VAD bundle caricato.');
        }}
      />

      <div className="bg-orb bg-orb-a" />
      <div className="bg-orb bg-orb-b" />

      <main className="demo-shell">
        <header className="hero">
          <p className="kicker">MemorAIz x H-Farm</p>
          <h1>Esame orale simulato con l&apos;assistente del professore</h1>
          <p className="lead">
            Un&apos;esperienza vocale in tempo reale, progettata per studenti universitari.
          </p>
        </header>

        <section className="stage-card" aria-label="Live demo panel">
          {/* Top row */}
          <div className="top-row">
            <div className="identity">
              <div className="logo-mark" aria-hidden="true">
                <svg width="30" height="30" viewBox="0 0 30 30" fill="none">
                  <circle cx="15" cy="15" r="10" stroke="currentColor" strokeWidth="1.4" opacity="0.45" />
                  <circle cx="15" cy="15" r="5" fill="currentColor" opacity="0.82" />
                </svg>
              </div>
              <div>
                <p className="identity-label">Persona attiva</p>
                <p className="identity-title">Assistente del Professore</p>
              </div>
            </div>

            <div className="timer-chip" aria-label="Durata sessione">
              <span>Sessione</span>
              <strong id="conversationTimer">{sessionTimer}</strong>
            </div>
          </div>

          {/* Robot + soundbars */}
          <div className="center-row">
            <div className="robot-container" id="robotContainer">
              <div className={`robot-ring${isSpeaking ? ' speaking' : ''}`} id="robotRing" />
              <div className={`robot-ring-2${isSpeaking ? ' speaking' : ''}`} id="robotRing2" />
              <div className="robot-svg-wrap">
                <svg width="104" height="104" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
                  <rect x="20" y="22" width="60" height="52" rx="10" fill="#10264a" stroke="#7cf9cc" strokeWidth="1.2" strokeOpacity="0.55"/>
                  <line x1="50" y1="22" x2="50" y2="10" stroke="#7cf9cc" strokeWidth="1.5" strokeOpacity="0.72"/>
                  <circle cx="50" cy="8" r="3.5" fill="#7cf9cc" opacity="0.95" id="antennaGlow"/>
                  <rect x="30" y="36" width="14" height="10" rx="3" fill="#7cf9cc" opacity="0.16"/>
                  <rect x="56" y="36" width="14" height="10" rx="3" fill="#7cf9cc" opacity="0.16"/>
                  <rect x="32" y="38" width="10" height="6" rx="2" fill="#7cf9cc"/>
                  <rect x="58" y="38" width="10" height="6" rx="2" fill="#7cf9cc"/>
                  <rect x="31" y="56" width="38" height="10" rx="4" fill="#0d1b33" stroke="#7cf9cc" strokeWidth="0.8" strokeOpacity="0.45"/>
                  <rect x="35" y="59" width="4" height="4" rx="1" fill="#7cf9cc" opacity={isSpeaking ? '0.9' : '0.5'} id="m1"/>
                  <rect x="42" y="59" width="4" height="4" rx="1" fill="#7cf9cc" opacity={isSpeaking ? '0.9' : '0.5'} id="m2"/>
                  <rect x="49" y="59" width="4" height="4" rx="1" fill="#7cf9cc" opacity={isSpeaking ? '0.9' : '0.5'} id="m3"/>
                  <rect x="56" y="59" width="4" height="4" rx="1" fill="#7cf9cc" opacity={isSpeaking ? '0.9' : '0.5'} id="m4"/>
                </svg>
              </div>
            </div>

            <div className={`sound-bars${isSpeaking ? ' active' : ''}`} id="soundBars" aria-hidden="true">
              <div className="bar" style={{ height: 6 }} />
              <div className="bar" style={{ height: 16 }} />
              <div className="bar" style={{ height: 10 }} />
              <div className="bar" style={{ height: 22 }} />
              <div className="bar" style={{ height: 8 }} />
              <div className="bar" style={{ height: 18 }} />
              <div className="bar" style={{ height: 12 }} />
            </div>
          </div>

          <p className="status" id="status">{statusText}</p>
          <p className="hint" id="sessionHint">
            I documenti sono <strong>facoltativi</strong>. Senza file si parte in modalità Free Roam.
            Carica un documento base per la mappa degli argomenti, poi premi <strong>Avvia Sessione</strong>.
          </p>

          {/* Document upload — optional */}
          <div className="doc-grid">
            <label className="doc-field" htmlFor="summaryDocInput">
              <span>Documento base <em style={{ fontWeight: 400, opacity: 0.6, fontSize: '0.85em' }}>(facoltativo)</em></span>
              <p className="doc-field-desc">PDF, TXT o Markdown. Usato per generare la mappa degli argomenti iniziale della sessione.</p>
              <div className="doc-field-btn">&#8593;&nbsp; Scegli file</div>
              <p className={`doc-field-filename${summaryFileName !== 'Nessun file selezionato' ? ' visible' : ''}`}>{summaryFileName}</p>
              <input
                id="summaryDocInput"
                ref={summaryInputRef}
                type="file"
                accept=".pdf,.docx,.odt,.rtf,.txt,.md,.markdown,.text,.html,.htm"
                disabled={sessionActive}
                onChange={(e) =>
                  setSummaryFileName(e.target.files?.[0]?.name ?? 'Nessun file selezionato')
                }
              />
            </label>

            <label className="doc-field" htmlFor="ragDocInput">
              <span>Documenti di supporto <em style={{ fontWeight: 400, opacity: 0.6, fontSize: '0.85em' }}>(facoltativi)</em></span>
              <p className="doc-field-desc">Uno o più file. Consultati in tempo reale durante la conversazione tramite ricerca semantica.</p>
              <div className="doc-field-btn">&#8593;&nbsp; Scegli file/i</div>
              <p className={`doc-field-filename${ragFileName !== 'Nessun file selezionato' ? ' visible' : ''}`}>{ragFileName}</p>
              <input
                id="ragDocInput"
                ref={ragInputRef}
                type="file"
                accept=".pdf,.docx,.odt,.rtf,.txt,.md,.markdown,.text,.html,.htm"
                multiple
                disabled={sessionActive}
                onChange={(e) => {
                  const files = e.target.files;
                  if (!files || files.length === 0) {
                    setRagFileName('Nessun file selezionato');
                  } else if (files.length === 1) {
                    setRagFileName(files[0].name);
                  } else {
                    setRagFileName(`${files.length} file selezionati`);
                  }
                }}
              />
            </label>
          </div>

          {/* Actions */}
          <div className="actions">
            <button
              id="startBtn"
              className="btn btn-primary"
              disabled={sessionActive}
              onClick={handleStart}
            >
              Avvia Sessione
            </button>
            <button
              id="stopBtn"
              className="btn btn-danger"
              disabled={!sessionActive}
              onClick={handleStop}
            >
              Termina
            </button>
          </div>

          {/* Text input */}
          <div className="composer">
            <input
              id="chatInput"
              type="text"
              placeholder="Messaggio testuale (facoltativo)..."
              disabled={!isConnected}
              value={chatValue}
              onChange={(e) => setChatValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSend();
              }}
            />
            <button
              id="sendBtn"
              className="btn btn-ghost"
              disabled={!isConnected || !chatValue.trim()}
              onClick={handleSend}
            >
              Invia
            </button>
          </div>
        </section>

        {/* ── Debug panel ──────────────────────────────────────────────────── */}
        <section style={{ width: '100%', maxWidth: 720, margin: '1.5rem auto 0' }}>
          <button
            type="button"
            onClick={() => setShowDebug((v) => !v)}
            style={{
              background: 'transparent',
              border: '1px solid rgba(124,249,204,0.25)',
              color: '#94a3b8',
              borderRadius: 8,
              padding: '6px 14px',
              cursor: 'pointer',
              fontSize: '0.8rem',
              fontFamily: 'IBM Plex Mono, monospace',
              letterSpacing: '0.05em',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: '0.65rem' }}>{showDebug ? '▼' : '▶'}</span>
            DEBUG LOG
            {logs.length > 0 && (
              <span style={{ background: 'rgba(124,249,204,0.12)', color: '#7cf9cc', borderRadius: 4, padding: '1px 6px', fontSize: '0.75rem' }}>
                {logs.length}
              </span>
            )}
            {!vadReady && (
              <span style={{ color: '#fb923c', fontSize: '0.72rem' }}>(VAD loading…)</span>
            )}
          </button>

          {showDebug && (
            <div
              style={{
                marginTop: 8,
                background: 'rgba(10,20,40,0.85)',
                border: '1px solid rgba(124,249,204,0.15)',
                borderRadius: 10,
                padding: '10px 14px',
                height: 340,
                overflowY: 'auto',
                fontFamily: 'IBM Plex Mono, monospace',
                fontSize: '0.78rem',
                lineHeight: 1.6,
              }}
            >
              {logs.length === 0 && (
                <div style={{ color: '#475569', fontStyle: 'italic' }}>
                  Nessun evento ancora. Avvia la sessione per vedere i log.
                </div>
              )}
              {logs.map((entry) => (
                <div key={entry.id} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', marginBottom: 2 }}>
                  <span style={{ color: '#475569', flexShrink: 0, userSelect: 'none' }}>{entry.ts}</span>
                  <span
                    style={{
                      color: LOG_COLORS[entry.type],
                      flexShrink: 0,
                      minWidth: 90,
                      fontWeight: 600,
                      userSelect: 'none',
                    }}
                  >
                    [{LOG_LABELS[entry.type]}]
                  </span>
                  <span style={{ color: '#cbd5e1', wordBreak: 'break-word' }}>{entry.text}</span>
                </div>
              ))}
              <div ref={debugEndRef} />
            </div>
          )}
        </section>
      </main>
    </>
  );
}
