const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const sendBtn = document.getElementById('sendBtn');
const chatInput = document.getElementById('chatInput');
const statusEl = document.getElementById('status');
const conversationTimerEl = document.getElementById('conversationTimer');
const sessionHintEl = document.getElementById('sessionHint');
const soundBars = document.getElementById('soundBars');
const robotRing = document.getElementById('robotRing');
const robotRing2 = document.getElementById('robotRing2');
const summaryDocInput = document.getElementById('summaryDocInput');
const ragDocInput = document.getElementById('ragDocInput');
const summaryDocName = document.getElementById('summaryDocName');
const ragDocName = document.getElementById('ragDocName');

const pageAssistantId = document.body?.dataset?.assistantId;
const assistantId = typeof pageAssistantId === 'string' && pageAssistantId.trim()
  ? pageAssistantId.trim()
  : 'professor';
const PLAYBACK_SAMPLE_RATE = 24000;
const SILERO_POSITIVE_SPEECH_THRESHOLD = 0.9;
const SILERO_NEGATIVE_SPEECH_THRESHOLD = 0.4;
const SILERO_MIN_SPEECH_MS = 180;
const TTS_SUPPRESSION_AFTER_INTERRUPTION_MS = 900;

let ws = null;
let micVad = null;
let playbackCtx = null;
let nextPlaybackTime = 0;
let conversationStartAt = null;
let conversationTimerInterval = null;
let ttsSuppressionUntilMs = 0;
let ttsSuppressionDropCount = 0;
let isSpeaking = false;
const activePlaybackSources = new Set();

function setRobotSpeaking(speaking) {
  isSpeaking = speaking;
  soundBars.classList.toggle('active', speaking);
  robotRing.classList.toggle('speaking', speaking);
  robotRing2.classList.toggle('speaking', speaking);

  const mouthPieces = ['m1', 'm2', 'm3', 'm4'];
  if (speaking) {
    let tick = 0;
    window._mouthInterval = setInterval(() => {
      tick += 1;
      mouthPieces.forEach((id, i) => {
        const el = document.getElementById(id);
        if (!el) return;
        const on = Math.sin(tick * 0.6 + i * 0.9) > 0.2;
        el.style.opacity = on ? '0.9' : '0.15';
      });
    }, 80);

    const antenna = document.getElementById('antennaGlow');
    if (antenna) {
      antenna.style.opacity = '1';
      antenna.style.filter = 'drop-shadow(0 0 4px #7cf9cc)';
    }
  } else {
    clearInterval(window._mouthInterval);
    mouthPieces.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.opacity = '0.5';
    });

    const antenna = document.getElementById('antennaGlow');
    if (antenna) {
      antenna.style.opacity = '0.95';
      antenna.style.filter = '';
    }
  }
}

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = `status ${cls}`;
}

function setHint(text) {
  sessionHintEl.textContent = text;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function updateConversationTimer() {
  if (conversationStartAt === null) {
    conversationTimerEl.textContent = '00:00';
    return;
  }
  conversationTimerEl.textContent = formatDuration(Date.now() - conversationStartAt);
}

function startConversationTimer() {
  conversationStartAt = Date.now();
  updateConversationTimer();
  if (conversationTimerInterval) clearInterval(conversationTimerInterval);
  conversationTimerInterval = setInterval(updateConversationTimer, 1000);
}

function stopConversationTimer() {
  if (conversationTimerInterval) {
    clearInterval(conversationTimerInterval);
    conversationTimerInterval = null;
  }
  conversationStartAt = null;
  conversationTimerEl.textContent = '00:00';
}

function setDocumentInputsDisabled(disabled) {
  summaryDocInput.disabled = disabled;
  ragDocInput.disabled = disabled;
}

async function uploadDocumentConfig() {
  const summaryFile = summaryDocInput.files?.[0] ?? null;
  const ragFiles = ragDocInput.files ? Array.from(ragDocInput.files) : [];

  if (!summaryFile && ragFiles.length === 0) {
    return { documentConfigId: null, summaryCount: 0, ragCount: 0, effectiveRagCount: 0 };
  }

  const formData = new FormData();
  if (summaryFile) formData.append('summaryDocument', summaryFile);
  ragFiles.forEach((file) => formData.append('ragDocuments', file));

  const response = await fetch('/api/document-config', {
    method: 'POST',
    body: formData,
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const errorText = payload?.error ?? `Upload failed with status ${response.status}`;
    throw new Error(errorText);
  }

  return {
    documentConfigId: payload?.documentConfigId ?? null,
    summaryCount: Number(payload?.summaryCount ?? 0),
    ragCount: Number(payload?.ragCount ?? 0),
    effectiveRagCount: Number(payload?.effectiveRagCount ?? 0),
  };
}

function int16ToFloat32(int16Array) {
  const out = new Float32Array(int16Array.length);
  for (let i = 0; i < int16Array.length; i++) {
    out[i] = Math.max(-1, Math.min(1, int16Array[i] / 32768));
  }
  return out;
}

function float32ToInt16(floatArray) {
  const out = new Int16Array(floatArray.length);
  for (let i = 0; i < floatArray.length; i++) {
    const s = Math.max(-1, Math.min(1, floatArray[i]));
    out[i] = s < 0 ? s * 32768 : s * 32767;
  }
  return out;
}

function base64ToArrayBuffer(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function stopAndClearPlayback() {
  for (const source of activePlaybackSources) {
    try {
      source.stop();
    } catch {
      // no-op
    }
  }
  activePlaybackSources.clear();
  nextPlaybackTime = 0;
  setRobotSpeaking(false);
}

function suppressTtsForInterruption(durationMs = TTS_SUPPRESSION_AFTER_INTERRUPTION_MS) {
  stopAndClearPlayback();
  ttsSuppressionUntilMs = Math.max(ttsSuppressionUntilMs, Date.now() + durationMs);
  ttsSuppressionDropCount = 0;
}

function shouldDropIncomingTtsChunk() {
  if (Date.now() < ttsSuppressionUntilMs) {
    ttsSuppressionDropCount += 1;
    return true;
  }

  if (ttsSuppressionUntilMs !== 0 && ttsSuppressionDropCount > 0) {
    setHint(`Sincronizzazione voce aggiornata (${ttsSuppressionDropCount} chunk saltati).`);
    ttsSuppressionDropCount = 0;
  }

  ttsSuppressionUntilMs = 0;
  return false;
}

function enqueueTtsAudio(b64data) {
  if (shouldDropIncomingTtsChunk()) return;
  const arrayBuffer = base64ToArrayBuffer(b64data);
  const byteLen = arrayBuffer.byteLength % 2 !== 0 ? arrayBuffer.byteLength - 1 : arrayBuffer.byteLength;
  const int16 = new Int16Array(arrayBuffer, 0, byteLen / 2);
  schedulePlaybackChunk(int16);
  setRobotSpeaking(true);
}

function schedulePlaybackChunk(int16) {
  if (!playbackCtx) playbackCtx = new AudioContext({ sampleRate: PLAYBACK_SAMPLE_RATE });
  if (playbackCtx.state === 'suspended') void playbackCtx.resume();

  const floatData = int16ToFloat32(int16);
  const audioBuffer = playbackCtx.createBuffer(1, floatData.length, PLAYBACK_SAMPLE_RATE);
  audioBuffer.copyToChannel(floatData, 0);

  const source = playbackCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(playbackCtx.destination);

  const now = playbackCtx.currentTime;
  if (nextPlaybackTime < now + 0.01) nextPlaybackTime = now + 0.01;

  activePlaybackSources.add(source);
  source.onended = () => {
    activePlaybackSources.delete(source);
    if (activePlaybackSources.size === 0) setRobotSpeaking(false);
  };

  source.start(nextPlaybackTime);
  nextPlaybackTime += audioBuffer.duration;
}

function stopMicCapture() {
  ttsSuppressionUntilMs = 0;
  ttsSuppressionDropCount = 0;
  if (micVad) {
    void micVad.destroy();
    micVad = null;
  }
}

async function startMicCapture() {
  if (!window.vad || !window.vad.MicVAD) throw new Error('MicVAD runtime not loaded.');

  micVad = await window.vad.MicVAD.new({
    model: 'legacy',
    startOnLoad: false,
    baseAssetPath: '/',
    onnxWASMBasePath: '/',
    positiveSpeechThreshold: SILERO_POSITIVE_SPEECH_THRESHOLD,
    negativeSpeechThreshold: SILERO_NEGATIVE_SPEECH_THRESHOLD,
    minSpeechMs: SILERO_MIN_SPEECH_MS,
    preSpeechPadMs: 160,
    redemptionMs: 900,
    // onSpeechRealStart: () => {
    //   if (activePlaybackSources.size > 0) {
    //     suppressTtsForInterruption();
    //   }
    // },
    onFrameProcessed: (_probabilities, audioFrame) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const int16 = float32ToInt16(audioFrame);
      const b64 = arrayBufferToBase64(int16.buffer);
      ws.send(JSON.stringify({ type: 'audio_chunk', data: b64 }));
    },
  });

  await micVad.start();
}

function sendTextPrompt() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = chatInput.value.trim();
  if (!text) return;
  stopAndClearPlayback();
  ws.send(JSON.stringify({ type: 'text_prompt', text }));
  chatInput.value = '';
}

async function startSession() {
  if (ws) return;
  startBtn.disabled = true;
  setStatus('Preparazione', '');
  setHint('Caricamento documenti in corso, attendi un momento...');

  let uploadResult;
  try {
    uploadResult = await uploadDocumentConfig();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    setStatus('Errore', 'error');
    setHint(`Upload documenti non riuscito: ${message}`);
    startBtn.disabled = false;
    return;
  }

  if (uploadResult.documentConfigId) {
    setHint(`Documenti elaborati con successo — riepilogo: ${uploadResult.summaryCount} file, RAG: ${uploadResult.effectiveRagCount} fonte/i. Connessione in corso...`);
  } else {
    setHint('Nessun documento caricato: la sessione partirà in modalità conversazione libera, senza contesto specifico.');
  }

  const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${scheme}//${window.location.host}`);
  ws.binaryType = 'arraybuffer';

  ws.onopen = async () => {
    try {
      await startMicCapture();
      ws.send(
        JSON.stringify({
          type: 'start_session',
          assistantId,
          documentConfigId: uploadResult.documentConfigId,
        }),
      );

      startConversationTimer();
      stopBtn.disabled = false;
      sendBtn.disabled = false;
      chatInput.disabled = false;
      setDocumentInputsDisabled(true);
      setStatus('Connesso', 'connected');
      setHint('Sessione live attiva — parla liberamente o digita un messaggio. Il microfono è acceso.');
    } catch (err) {
      setStatus('Errore', 'error');
      setHint(`Microfono non disponibile: ${err instanceof Error ? err.message : String(err)}`);
      stopSession();
    }
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;

    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    if (msg.type === 'status') {
      const text = String(msg.message ?? '');
      if (text.includes('Connected!')) {
        setStatus('Connesso', 'connected');
        setHint("L'assistente del professore è pronto. Puoi iniziare a rispondere alle domande o porre chiarimenti.");
      } else if (text.toLowerCase().includes('error')) {
        setStatus('Errore', 'error');
        setHint(text);
      } else if (text.includes('Connessione ripristinata')) {
        setStatus('Connesso', 'connected');
        setHint('Connessione WebSocket ripristinata correttamente — la sessione riprende normalmente.');
      }
    }

    if (msg.type === 'error') {
      setStatus('Errore', 'error');
      setHint(`Sessione non disponibile: ${msg.message ?? 'errore sconosciuto'}`);
      stopSession();
    }

    if (msg.type === 'transcript') {
      if (msg.role === 'model') {
        setStatus('Sta parlando', 'speaking');
      } else if (msg.role === 'user') {
        setStatus('Ti ascolta', 'connected');
      }
    }

    if (msg.type === 'rag_tool_called') {
      const sourceCount = Array.isArray(msg.sources) ? msg.sources.length : 0;
      setHint(`Ricerca semantica completata — trovati risultati in ${sourceCount} fonte/i. L'assistente sta elaborando la risposta.`);
    }

    if (msg.type === 'session_cost_summary') {
      const hasPricing = Boolean(msg.pricingConfigured);
      const totalCost = hasPricing ? `$${Number(msg.estimatedCostUsd ?? 0).toFixed(6)}` : 'non configurata';
      setHint(`Sessione terminata. Costo stimato per questa conversazione: ${totalCost}. Puoi ricaricare i documenti e avviare una nuova sessione.`);
      setStatus('Pronto', '');
    }

    if (msg.type === 'vad_event') {
      const source = String(msg.source ?? 'gemini').toLowerCase();
      if (source === 'gemini') {
        suppressTtsForInterruption(1200);
      }
    }

    if (msg.type === 'tts_audio' && msg.data) {
      enqueueTtsAudio(msg.data);
    }
  };

  ws.onerror = () => {
    setStatus('Errore', 'error');
    setHint('Errore di connessione WebSocket. Controlla che il server sia attivo e riprova.');
  };

  ws.onclose = () => {
    stopAndClearPlayback();
    stopMicCapture();
    stopConversationTimer();
    setRobotSpeaking(false);
    ws = null;

    startBtn.disabled = false;
    stopBtn.disabled = true;
    sendBtn.disabled = true;
    chatInput.disabled = true;
    setDocumentInputsDisabled(false);

    setStatus('Pronto', '');
    setHint('Sessione terminata. Puoi caricare nuovi documenti e avviare una nuova sessione quando vuoi.');
  };
}

function stopSession() {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'end_session' }));
    ws.close();
  } else {
    ws = null;
  }
  stopMicCapture();
}

startBtn.addEventListener('click', () => void startSession());
stopBtn.addEventListener('click', () => stopSession());
sendBtn.addEventListener('click', () => sendTextPrompt());
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    sendTextPrompt();
  }
});

// Filename display feedback
summaryDocInput.addEventListener('change', () => {
  const file = summaryDocInput.files?.[0];
  if (summaryDocName) {
    summaryDocName.textContent = file ? file.name : 'Nessun file selezionato';
    summaryDocName.classList.toggle('visible', Boolean(file));
  }
});

ragDocInput.addEventListener('change', () => {
  const files = ragDocInput.files ? Array.from(ragDocInput.files) : [];
  if (ragDocName) {
    if (files.length === 0) {
      ragDocName.textContent = 'Nessun file selezionato';
      ragDocName.classList.remove('visible');
    } else if (files.length === 1) {
      ragDocName.textContent = files[0].name;
      ragDocName.classList.add('visible');
    } else {
      ragDocName.textContent = `${files.length} file selezionati`;
      ragDocName.classList.add('visible');
    }
  }
});
