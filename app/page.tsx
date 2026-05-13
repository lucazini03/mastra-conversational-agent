'use client';
// app/page.tsx
//
// Clean professor-focused landing page for MemorAIz.
// Mirrors the existing public/index.html UI in React.
// The VAD runtime is loaded from the static bundles in /public via next/script.

import { useState, useRef, useEffect, useCallback } from 'react';
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

// ── Page ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  // ── State ──────────────────────────────────────────────────────────────
  const [statusText, setStatusText] = useState('Pronto');
  const [hintText, setHintText] = useState(
    'Carica i tuoi documenti usando le zone qui sopra, poi premi Avvia Sessione per iniziare l\'esame orale.',
  );
  const [sessionTimer, setSessionTimer] = useState('00:00');
  const [summaryFileName, setSummaryFileName] = useState('Nessun file selezionato');
  const [ragFileName, setRagFileName] = useState('Nessun file selezionato');
  const [chatValue, setChatValue] = useState('');
  const [sessionActive, setSessionActive] = useState(false);
  const [scriptsReady, setScriptsReady] = useState(false);

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
    onStatus: (msg) => setStatusText(msg),
    onTranscript: (_role, _text) => {
      // Transcript display is handled by the hook internally.
      // Extend here to display in UI if desired.
    },
    onSpeakingChange: (_speaking) => {
      // Robot animation driven by isSpeaking from hook
    },
    onContextSwitch: (n) => {
      setStatusText(`Context switch #${n} completato.`);
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

  // ── File upload ───────────────────────────────────────────────────────────
  async function uploadDocuments(): Promise<{ documentConfigId: string | null }> {
    const summaryFile = summaryInputRef.current?.files?.[0] ?? null;
    const ragFiles = ragInputRef.current?.files
      ? Array.from(ragInputRef.current.files)
      : [];

    if (!summaryFile && ragFiles.length === 0) {
      return { documentConfigId: null };
    }

    const form = new FormData();
    if (summaryFile) form.append('summaryDocument', summaryFile);
    ragFiles.forEach((f) => form.append('ragDocuments', f));

    const res = await fetch('/api/document-config', { method: 'POST', body: form });
    if (!res.ok) {
      const payload = await res.json().catch(() => ({}));
      throw new Error(payload?.error ?? `Upload failed (${res.status})`);
    }
    const data = await res.json();
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
  }, []);

  const startVad = useCallback(async () => {
    const w = window as any;
    if (!w.vad?.MicVAD) throw new Error('MicVAD runtime not loaded.');

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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendMicAudio, signalSpeechStart, signalSpeechEnd, stopPlayback]);

  // ── Start / stop ──────────────────────────────────────────────────────────

  async function handleStart() {
    if (sessionActive) return;
    setStatusText('Preparazione documenti...');
    setHintText('Caricamento documenti in corso, attendi un momento...');

    try {
      const { documentConfigId } = await uploadDocuments();

      setStatusText('Connessione a Gemini...');
      await startSession({ assistantId: 'professor', documentConfigId: documentConfigId ?? undefined });

      setSessionActive(true);
      startTimer();
      setHintText('Sessione avviata. Inizia a parlare!');

      await startVad();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatusText(`Errore: ${msg}`);
      setHintText('Riprova o controlla la console per i dettagli.');
      setSessionActive(false);
      stopTimer();
    }
  }

  function handleStop() {
    void stopVad();
    endSession();
    setSessionActive(false);
    stopTimer();
    setStatusText('Sessione terminata.');
    setHintText('Premi Avvia Sessione per iniziare una nuova sessione.');
  }

  function handleSend() {
    if (!chatValue.trim() || status !== 'ready') return;
    sendText(chatValue);
    setChatValue('');
  }

  // ── Sync status text to hook status ──────────────────────────────────────
  useEffect(() => {
    if (status === 'ready' && !sessionActive) {
      // Edge case: reconnect resolved
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
      {/* Styles from the existing CSS (served from public/) */}
      {/* eslint-disable-next-line @next/next/no-page-custom-font */}
      <link rel="stylesheet" href="/index.css" />

      {/* VAD scripts — must load before session start */}
      <Script src="/ort.min.js" strategy="beforeInteractive" />
      <Script
        src="/vad.bundle.min.js"
        strategy="beforeInteractive"
        onLoad={() => setScriptsReady(true)}
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
          <p className="hint" id="sessionHint">{hintText}</p>

          {/* Document upload */}
          <div className="doc-grid">
            <label className="doc-field" htmlFor="summaryDocInput">
              <span>Documento base</span>
              <p className="doc-field-desc">PDF, TXT o Markdown. Usato per generare la mappa degli argomenti iniziale della sessione.</p>
              <div className="doc-field-btn">&#8593;&nbsp; Scegli file</div>
              <p className="doc-field-filename">{summaryFileName}</p>
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
              <span>Documenti di supporto</span>
              <p className="doc-field-desc">Uno o più file. Consultati in tempo reale durante la conversazione tramite ricerca semantica.</p>
              <div className="doc-field-btn">&#8593;&nbsp; Scegli file/i</div>
              <p className="doc-field-filename">{ragFileName}</p>
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
              disabled={sessionActive || !scriptsReady}
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
      </main>
    </>
  );
}
