// shared.js — Common WebSocket + audio + VAD logic for APP CIAO demos.
//
// Each demo page sets window.DEMO_ID before loading this script:
//   window.DEMO_ID = 'demo_1' | 'demo_2' | 'demo_3' | 'demo_4'
//
// For demo_4 the Silero VAD is disabled and replaced by a Walkie-Talkie
// push-to-talk interface. All other demos use the standard Silero VAD flow.

(function () {
  // ── Config ─────────────────────────────────────────────────────────────────
  const DEMO_ID = window.DEMO_ID || 'demo_1';
  // DEMO_VAD_MODE: 'push-to-talk' activates walkie-talkie buttons (demo4_buttons);
  //               'continuous' uses Silero VAD (demo4_flow + demos 1-3).
  // Falls back to legacy check so existing demo4.html still works unchanged.
  const IS_WALKIE_TALKIE =
    typeof window.DEMO_VAD_MODE !== 'undefined'
      ? window.DEMO_VAD_MODE === 'push-to-talk'
      : DEMO_ID === 'demo_4';

  const PLAYBACK_SAMPLE_RATE = 24000;
  const MIC_SAMPLE_RATE = 16000;
  const SILERO_POSITIVE_SPEECH_THRESHOLD = 0.9;
  const SILERO_NEGATIVE_SPEECH_THRESHOLD = 0.4;
  const SILERO_MIN_SPEECH_MS = 180;
  const TTS_SUPPRESSION_AFTER_INTERRUPTION_MS = 900;
  const VAD_PREROLL_MS = 280;
  const VAD_PREROLL_MAX_BYTES = Math.floor((MIC_SAMPLE_RATE * 2 * VAD_PREROLL_MS) / 1000);
  const TRANSCRIPT_MERGE_WINDOW_MS = 1400;

  // ── DOM refs (all optional — pages may omit elements they don't need) ──────
  const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const statusEl = document.getElementById('status');
  const sessionHintEl = document.getElementById('sessionHint');
  const conversationTimerEl = document.getElementById('conversationTimer');
  const soundBars = document.getElementById('soundBars');
  const robotRing = document.getElementById('robotRing');
  const robotRing2 = document.getElementById('robotRing2');

  // Demo-4 walkie-talkie buttons
  const nativeSpeakBtn = document.getElementById('nativeSpeakBtn');
  const italianSpeakBtn = document.getElementById('italianSpeakBtn');

  // Demo-4 practice mode UI
  const practiceBtn = document.getElementById('practiceBtn');
  const difficultySelect = document.getElementById('difficultySelect');

  // Demo 1/2/3 feedback mode UI
  const feedbackBtn = document.getElementById('feedbackBtn');

  // ── State ──────────────────────────────────────────────────────────────────
  let ws = null;
  let micVad = null;
  let sessionReady = false;
  let isSpeaking = false;
  let conversationStartAt = null;
  let conversationTimerInterval = null;
  let playbackCtx = null;
  let nextPlaybackTime = 0;
  const activePlaybackSources = new Set();
  let lastTranscriptEntry = null;
  let ttsSuppressionUntilMs = 0;
  let ttsSuppressionDropCount = 0;
  let isVadActive = false;
  let vadPrerollFrames = [];
  let vadPrerollBytes = 0;

  // Walkie-talkie mic stream state (demo_4 only)
  let wt_micStream = null;
  let wt_audioCtx = null;
  let wt_processor = null;
  let wt_activeButton = null;       // 'native' | 'italian' | null
  let wt_pendingByte = null;        // odd-byte buffer for alignment

  // Demo-4 practice session state
  let transcriptLinesData = [];     // [{role, text}] accumulated during translation session
  let selectedDifficulty = 'easy'; // mirrors #difficultySelect value
  let pendingPracticeContext = null; // set when practice_ready arrives, consumed on ws.onclose

  // Demo 1/2/3 feedback session state
  let pendingFeedbackContext = null;  // set when feedback_ready arrives, consumed on ws.onclose
  let pendingFeedbackDemoId = null;   // review demoId (e.g. 'demo_1_review') from feedback_ready

  // ── Robot animation ──────────────────────────────────────────────────────
  function setRobotSpeaking(speaking) {
    isSpeaking = speaking;
    soundBars?.classList.toggle('active', speaking);
    robotRing?.classList.toggle('speaking', speaking);
    robotRing2?.classList.toggle('speaking', speaking);

    const mouthPieces = ['m1', 'm2', 'm3', 'm4'];
    if (speaking) {
      let tick = 0;
      window._mouthInterval = setInterval(() => {
        tick++;
        mouthPieces.forEach((id, i) => {
          const el = document.getElementById(id);
          if (!el) return;
          const on = Math.sin(tick * 0.6 + i * 0.9) > 0.2;
          el.style.opacity = on ? '0.9' : '0.15';
        });
      }, 80);
      const antenna = document.getElementById('antennaGlow');
      if (antenna) { antenna.style.opacity = '1'; antenna.style.filter = 'drop-shadow(0 0 4px #38bdf8)'; }
    } else {
      clearInterval(window._mouthInterval);
      mouthPieces.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.opacity = '0.5';
      });
      const antenna = document.getElementById('antennaGlow');
      if (antenna) { antenna.style.opacity = '0.9'; antenna.style.filter = ''; }
    }
  }

  function setDisabled(el, disabled) {
    if (!el) return;
    el.disabled = disabled;
  }

  function setHint(text) {
    if (!sessionHintEl) return;
    sessionHintEl.textContent = text;
  }

  // ── Transcript helpers ────────────────────────────────────────────────────
  const transcriptLog = document.getElementById('transcriptLog');
  const transcriptArea = document.getElementById('transcriptArea');
  const transcriptEmpty = document.getElementById('transcriptEmpty');

  function mergeTranscriptText(previous, incoming) {
    const prev = String(previous ?? '').trim();
    const next = String(incoming ?? '').trim();
    if (!prev) return next;
    if (!next) return prev;
    if (next.startsWith(prev)) return next;
    if (prev.startsWith(next)) return prev;
    const maxOverlap = Math.min(prev.length, next.length);
    for (let overlap = maxOverlap; overlap >= 1; overlap--) {
      if (prev.slice(-overlap) === next.slice(0, overlap)) {
        return `${prev}${next.slice(overlap)}`.trim();
      }
    }
    return `${prev} ${next}`.replace(/\s+/g, ' ').trim();
  }

  function createTranscriptLine(role, text) {
    if (!transcriptLog) return null;
    if (transcriptEmpty) transcriptEmpty.style.display = 'none';
    const wrap = document.createElement('div');
    wrap.className = `transcript-line ${role}`;
    const label = document.createElement('div');
    label.className = 'transcript-label';
    label.textContent = role === 'user' ? 'Tu' : 'AI';
    const body = document.createElement('div');
    body.className = 'transcript-text';
    body.textContent = text;
    wrap.appendChild(label);
    wrap.appendChild(body);
    transcriptLog.appendChild(wrap);
    if (transcriptArea) transcriptArea.scrollTop = transcriptArea.scrollHeight;
    return { wrap, body };
  }

  function logTranscript(role, text) {
    if (!transcriptLog) return;
    const now = Date.now();
    const normalizedText = String(text ?? '').trim();
    if (!normalizedText) return;
    if (role !== 'model') {
      // Still accumulate data but don't show user turns in the UI.
      if (DEMO_ID === 'demo_4' || DEMO_ID === 'demo_4_practice' ||
          DEMO_ID === 'demo_1' || DEMO_ID === 'demo_2' || DEMO_ID === 'demo_3') {
        transcriptLinesData.push({ role, text: normalizedText });
      }
      return;
    }

    if (
      lastTranscriptEntry &&
      lastTranscriptEntry.role === role &&
      now - lastTranscriptEntry.at <= TRANSCRIPT_MERGE_WINDOW_MS
    ) {
      const merged = mergeTranscriptText(lastTranscriptEntry.text, normalizedText);
      lastTranscriptEntry.text = merged;
      lastTranscriptEntry.at = now;
      if (lastTranscriptEntry.bodyEl) lastTranscriptEntry.bodyEl.textContent = merged;
      if (transcriptArea) transcriptArea.scrollTop = transcriptArea.scrollHeight;
      return;
    }

    const result = createTranscriptLine(role, normalizedText);
    lastTranscriptEntry = { role, text: normalizedText, at: now, wrap: result?.wrap, bodyEl: result?.body };

    // Accumulate transcript for practice/feedback features.
    if (DEMO_ID === 'demo_4' || DEMO_ID === 'demo_4_practice' ||
        DEMO_ID === 'demo_1' || DEMO_ID === 'demo_2' || DEMO_ID === 'demo_3') {
      transcriptLinesData.push({ role, text: normalizedText });
    }
  }

  // ── Status helpers ─────────────────────────────────────────────────────────
  function setStatus(text, cls = '') {
    if (!statusEl) return;
    statusEl.textContent = text;
    statusEl.className = `status ${cls}`.trim();
  }

  // ── Timer helpers ──────────────────────────────────────────────────────────
  function formatDuration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }

  function startConversationTimer() {
    conversationStartAt = Date.now();
    if (conversationTimerEl) conversationTimerEl.textContent = '00:00';
    if (conversationTimerInterval) clearInterval(conversationTimerInterval);
    conversationTimerInterval = setInterval(() => {
      if (conversationTimerEl && conversationStartAt !== null) {
        conversationTimerEl.textContent = formatDuration(Date.now() - conversationStartAt);
      }
    }, 1000);
  }

  function stopConversationTimer() {
    if (conversationTimerInterval) { clearInterval(conversationTimerInterval); conversationTimerInterval = null; }
    conversationStartAt = null;
    if (conversationTimerEl) conversationTimerEl.textContent = '00:00';
  }

  // ── Audio helpers ──────────────────────────────────────────────────────────
  function int16ToFloat32(int16Array) {
    const out = new Float32Array(int16Array.length);
    for (let i = 0; i < int16Array.length; i++) out[i] = Math.max(-1, Math.min(1, int16Array[i] / 32768));
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
    for (const source of activePlaybackSources) { try { source.stop(); } catch (_) {} }
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
    ttsSuppressionUntilMs = 0;
    ttsSuppressionDropCount = 0;
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

  // ── VAD preroll (demos 1-3 only) ───────────────────────────────────────────
  function resetVadPrerollBuffer() { vadPrerollFrames = []; vadPrerollBytes = 0; }

  function pushVadPrerollFrame(int16) {
    const frame = int16.slice();
    vadPrerollFrames.push(frame);
    vadPrerollBytes += frame.byteLength;
    while (vadPrerollBytes > VAD_PREROLL_MAX_BYTES && vadPrerollFrames.length > 0) {
      const dropped = vadPrerollFrames.shift();
      if (!dropped) break;
      vadPrerollBytes -= dropped.byteLength;
    }
  }

  function sendMicChunkInt16(int16) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const b64 = arrayBufferToBase64(int16.buffer);
    ws.send(JSON.stringify({ type: 'audio_chunk', data: b64 }));
    return true;
  }

  function flushVadPreroll() {
    if (!ws || ws.readyState !== WebSocket.OPEN) { resetVadPrerollBuffer(); return; }
    for (const frame of vadPrerollFrames) sendMicChunkInt16(frame);
    resetVadPrerollBuffer();
  }

  // ── Silero VAD mic capture (demos 1-3) ─────────────────────────────────────
  function stopMicCapture() {
    isVadActive = false;
    resetVadPrerollBuffer();
    ttsSuppressionUntilMs = 0;
    ttsSuppressionDropCount = 0;
    if (micVad) { void micVad.destroy(); micVad = null; }
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
      onSpeechRealStart: () => {
        isVadActive = true;
        if (activePlaybackSources.size > 0) suppressTtsForInterruption();
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'activity_start' }));
        flushVadPreroll();
      },
      onSpeechEnd: () => {
        isVadActive = false;
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'activity_end' }));
        resetVadPrerollBuffer();
      },
      onFrameProcessed: (_probabilities, audioFrame) => {
        if (!ws || ws.readyState !== WebSocket.OPEN) { resetVadPrerollBuffer(); return; }
        const int16 = float32ToInt16(audioFrame);
        if (isVadActive) { sendMicChunkInt16(int16); return; }
        pushVadPrerollFrame(int16);
      },
    });
    await micVad.start();
  }

  // ── Walkie-Talkie mic capture (demo_4 only) ────────────────────────────────
  async function wtStartSpeaking(languageHint) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (wt_activeButton) return; // already recording
    wt_activeButton = languageHint;
    wt_pendingByte = null;

    // Stop any ongoing TTS playback — user is taking the floor.
    suppressTtsForInterruption();

    // Get mic access if not already acquired.
    if (!wt_micStream) {
      wt_micStream = await navigator.mediaDevices.getUserMedia({ audio: { sampleRate: MIC_SAMPLE_RATE, channelCount: 1 }, video: false });
    }

    wt_audioCtx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE });
    const source = wt_audioCtx.createMediaStreamSource(wt_micStream);

    // Use ScriptProcessorNode for simplicity (bufferSize 4096 ≈ 256ms @16kHz)
    // eslint-disable-next-line deprecation/deprecation
    wt_processor = wt_audioCtx.createScriptProcessor(4096, 1, 1);
    wt_processor.onaudioprocess = (e) => {
      if (!wt_activeButton || !ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      // float32ToInt16 returns an Int16Array whose .buffer is always
      // even-length (bufferSize=4096 samples × 2 bytes = 8192 bytes).
      // We use pure TypedArray ops — no Node.js Buffer needed.
      const int16 = float32ToInt16(float32);
      const b64 = arrayBufferToBase64(int16.buffer);
      ws.send(JSON.stringify({ type: 'audio_chunk', data: b64 }));
    };

    source.connect(wt_processor);
    wt_processor.connect(wt_audioCtx.destination);

    ws.send(JSON.stringify({ type: 'activity_start' }));
    ws.send(JSON.stringify({ type: 'language_spoken', language: languageHint }));

    setStatus('Listening...', 'connected');
    setWalkieTalkieActive(languageHint, true);
  }

  function wtStopSpeaking() {
    if (!wt_activeButton) return;
    wt_activeButton = null;
    wt_pendingByte = null;

    if (wt_processor) { try { wt_processor.disconnect(); } catch (_) {} wt_processor = null; }
    if (wt_audioCtx) { try { wt_audioCtx.close(); } catch (_) {} wt_audioCtx = null; }

    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'activity_end' }));

    setStatus('Connected', 'connected');
    setWalkieTalkieActive(null, false);
  }

  function setWalkieTalkieActive(button, active) {
    if (nativeSpeakBtn) nativeSpeakBtn.classList.toggle('active', active && button === 'native');
    if (italianSpeakBtn) italianSpeakBtn.classList.toggle('active', active && button === 'italian');
  }

  function stopWalkieTalkieMic() {
    wtStopSpeaking();
    if (wt_micStream) {
      wt_micStream.getTracks().forEach(t => t.stop());
      wt_micStream = null;
    }
  }

  // ── Practice session (demo_4) ──────────────────────────────────────────────
  async function startPracticeSession(context, difficulty) {
    if (ws) return; // already have a session open
    transcriptLinesData = []; // reset for the new session
    sessionReady = false;
    setDisabled(startBtn, true);
    setDisabled(practiceBtn, true);
    setStatus('Connessione pratica...', '');
    setHint('Avvio sessione di pratica in italiano...');

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${scheme}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      try {
        if (!IS_WALKIE_TALKIE) {
          await startMicCapture();
        }
        ws.send(JSON.stringify({
          type: 'start_session',
          demoId: 'demo_4_practice',
          practiceContext: context,
          difficulty: selectedDifficulty,
        }));
        startConversationTimer();
        setDisabled(stopBtn, false);
        if (IS_WALKIE_TALKIE) setWalkieTalkieButtonsDisabled(false);
        setHint('Sessione di pratica attiva. Ascolta il tutor...');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('Errore microfono', 'error');
        setHint(`Microfono non disponibile: ${msg}`);
        stopSession();
      }
    };

    attachCommonWsHandlers(ws);
  }

  // ── Feedback session (demo_1/2/3 review) ──────────────────────────────────
  async function startFeedbackSession(context, reviewDemoId, difficulty) {
    if (ws) return; // already have a session open
    transcriptLinesData = []; // reset for the new session
    sessionReady = false;
    setDisabled(startBtn, true);
    setDisabled(feedbackBtn, true);
    setStatus('Connessione feedback...', '');
    setHint('Avvio sessione di feedback in italiano...');

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${scheme}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      try {
        await startMicCapture();
        ws.send(JSON.stringify({
          type: 'start_session',
          demoId: reviewDemoId,
          feedbackContext: context,
          difficulty: selectedDifficulty,
        }));
        startConversationTimer();
        setDisabled(stopBtn, false);
        setHint('Sessione di feedback attiva. Ascolta il tutor...');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('Errore microfono', 'error');
        setHint(`Microfono non disponibile: ${msg}`);
        stopSession();
      }
    };

    attachCommonWsHandlers(ws);
  }

  // ── Session lifecycle ──────────────────────────────────────────────────────

  // Shared WS message/error/close handlers — used by both startSession and startPracticeSession.
  function attachCommonWsHandlers(socket) {
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') return;
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      if (msg.type === 'status') {
        const txt = String(msg.message ?? '');
        if (txt.includes('Connected!') && !sessionReady) {
          sessionReady = true;
          setStatus('Connesso', 'connected');
          setHint(getReadyHint());
          // Enable practice button once session is live (demo_4 translation only)
          if (DEMO_ID === 'demo_4') setDisabled(practiceBtn, false);
          // Enable feedback button once session is live (demo_1 / demo_2 / demo_3)
          if (DEMO_ID === 'demo_1' || DEMO_ID === 'demo_2' || DEMO_ID === 'demo_3') setDisabled(feedbackBtn, false);
        } else if (txt.includes('Connection restored')) {
          setStatus('Connesso', 'connected');
        } else if (!txt.includes('Reconnecting') && !txt.includes('Optimizing')) {
          setStatus(txt, txt.toLowerCase().includes('error') ? 'error' : '');
        }
      }

      if (msg.type === 'error') {
        setStatus('Errore', 'error');
        setHint(`Errore di sessione: ${msg.message ?? 'sconosciuto'}`);
        stopSession();
      }

      if (msg.type === 'transcript') {
        logTranscript(msg.role, msg.text);
        if (msg.role === 'model') setStatus('Risposta in corso...', 'speaking');
        if (msg.role === 'user') setStatus('In ascolto...', 'connected');
      }

      if (msg.type === 'vad_event') {
        const source = String(msg.source ?? 'gemini').toLowerCase();
        if (source === 'gemini') suppressTtsForInterruption(1200);
      }

      if (msg.type === 'tts_audio' && msg.data) {
        enqueueTtsAudio(msg.data);
      }

      if (msg.type === 'session_cost_summary') {
        setStatus('Sessione terminata', '');
        setHint('La sessione è terminata. Puoi iniziarne una nuova.');
      }

      if (msg.type === 'practice_ready') {
        // Server has extracted the practice context.  Store it so that onclose
        // can start the practice session after the WS fully closes.
        pendingPracticeContext = msg.context ?? null;
        const diff = msg.difficulty ?? selectedDifficulty;
        // Now cleanly end the translation session.
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'end_session' }));
        }
        // Note: the actual practice session start happens in ws.onclose below.
        setStatus('Avvio pratica...', 'connected');
        setHint('Sessione di traduzione terminata. Avvio sessione di pratica...');
        selectedDifficulty = diff;
      }

      if (msg.type === 'feedback_ready') {
        // Server has extracted the feedback context. Store it so that onclose
        // can start the review session after the WS fully closes.
        pendingFeedbackContext = msg.context ?? null;
        pendingFeedbackDemoId = msg.reviewDemoId ?? null;
        const diff = msg.difficulty ?? selectedDifficulty;
        // Cleanly end the current session.
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'end_session' }));
        }
        setStatus('Avvio feedback...', 'connected');
        setHint('Sessione terminata. Avvio sessione di feedback...');
        selectedDifficulty = diff;
      }
    };

    socket.onerror = () => {
      setStatus('Errore connessione', 'error');
      setHint('Errore WebSocket. Controlla che il server sia in esecuzione.');
    };

    socket.onclose = () => {
      stopAndClearPlayback();
      if (!IS_WALKIE_TALKIE) stopMicCapture();
      else stopWalkieTalkieMic();
      stopConversationTimer();
      setRobotSpeaking(false);
      sessionReady = false;
      ws = null;
      setDisabled(startBtn, false);
      setDisabled(stopBtn, true);
      if (IS_WALKIE_TALKIE) setWalkieTalkieButtonsDisabled(true);
      setDisabled(practiceBtn, true);
      setDisabled(feedbackBtn, true);

      // If a feedback_ready message arrived before close, auto-start feedback session.
      if (pendingFeedbackContext) {
        const ctx = pendingFeedbackContext;
        const reviewId = pendingFeedbackDemoId;
        const diff = selectedDifficulty;
        pendingFeedbackContext = null;
        pendingFeedbackDemoId = null;
        void startFeedbackSession(ctx, reviewId, diff);
        return;
      }

      // If a practice_ready message arrived before close, auto-start practice session.
      if (pendingPracticeContext) {
        const ctx = pendingPracticeContext;
        const diff = selectedDifficulty;
        pendingPracticeContext = null;
        void startPracticeSession(ctx, diff);
        return;
      }

      setStatus('Pronto', '');
      setHint('Sessione terminata. Premi "Inizia" per una nuova sessione.');
    };
  }

  async function startSession() {
    if (ws) return;
    sessionReady = false;
    setDisabled(startBtn, true);
    setStatus('Connessione...', '');
    setHint('Connessione al server in corso...');

    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${scheme}//${window.location.host}`);
    ws.binaryType = 'arraybuffer';

    ws.onopen = async () => {
      try {
        // For demos 1-3, start Silero VAD; for demo 4, wait for push-to-talk.
        if (!IS_WALKIE_TALKIE) {
          await startMicCapture();
        }
        ws.send(JSON.stringify({ type: 'start_session', demoId: DEMO_ID, difficulty: selectedDifficulty }));
        startConversationTimer();
        setDisabled(stopBtn, false);
        if (IS_WALKIE_TALKIE) {
          setWalkieTalkieButtonsDisabled(false);
        }
        setHint('Sessione attiva. In attesa del tutor...');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setStatus('Errore microfono', 'error');
        setHint(`Microfono non disponibile: ${msg}`);
        stopSession();
      }
    };

    attachCommonWsHandlers(ws);
  }

  function stopSession() {
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'end_session' }));
    } else {
      ws = null;
    }
    if (!IS_WALKIE_TALKIE) stopMicCapture();
    else stopWalkieTalkieMic();
  }

  function getReadyHint() {
    if (DEMO_ID === 'demo_1') return 'Il tutor è pronto. Ascolta la frase e ripetila!';
    if (DEMO_ID === 'demo_2') return 'Il personaggio è pronto. Inizia la conversazione!';
    if (DEMO_ID === 'demo_3') return 'Il selezionatore è pronto. Presentati!';
    if (DEMO_ID === 'demo_4' && IS_WALKIE_TALKIE) return 'Il traduttore è pronto. Tieni premuto un pulsante per parlare.';
    if (DEMO_ID === 'demo_4' && !IS_WALKIE_TALKIE) return 'Il traduttore è pronto. Parla italiano o nella tua lingua — traduco automaticamente.';
    return 'Pronto.';
  }

  function setWalkieTalkieButtonsDisabled(disabled) {
    setDisabled(nativeSpeakBtn, disabled);
    setDisabled(italianSpeakBtn, disabled);
    // also disable practice button whenever walkie-talkie buttons are disabled
    // (i.e. session not yet active).  Re-enabled explicitly after session ready.
    if (disabled) setDisabled(practiceBtn, true);
  }

  // ── Event wiring ───────────────────────────────────────────────────────────
  startBtn?.addEventListener('click', () => void startSession());
  stopBtn?.addEventListener('click', () => stopSession());

  // Difficulty selector (demo_4)
  if (difficultySelect) {
    difficultySelect.addEventListener('change', () => {
      selectedDifficulty = difficultySelect.value;
    });
    selectedDifficulty = difficultySelect.value || 'easy';
  }

  // Practice button (demo_4)
  practiceBtn?.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionReady) return;
    setDisabled(practiceBtn, true);
    setStatus('Analisi conversazione...', 'connected');
    setHint('Estrazione del contesto di pratica dalla conversazione...');
    ws.send(JSON.stringify({
      type: 'initiate_practice',
      transcript: transcriptLinesData,
      difficulty: selectedDifficulty,
    }));
  });

  // Feedback button (demo_1 / demo_2 / demo_3)
  feedbackBtn?.addEventListener('click', () => {
    if (!ws || ws.readyState !== WebSocket.OPEN || !sessionReady) return;
    setDisabled(feedbackBtn, true);
    setStatus('Analisi conversazione...', 'connected');
    setHint('Estrazione del contesto di feedback dalla conversazione...');
    ws.send(JSON.stringify({
      type: 'initiate_feedback',
      demoId: DEMO_ID,
      transcript: transcriptLinesData,
      difficulty: selectedDifficulty,
    }));
  });

  // Walkie-talkie push-to-talk (demo_4)
  if (IS_WALKIE_TALKIE) {
    function bindPTT(btn, langHint) {
      if (!btn) return;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        btn.setPointerCapture(e.pointerId);
        void wtStartSpeaking(langHint);
      });
      btn.addEventListener('pointerup', () => wtStopSpeaking());
      btn.addEventListener('pointercancel', () => wtStopSpeaking());
      // Keyboard support: Space/Enter holds while key is down
      btn.addEventListener('keydown', (e) => {
        if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) void wtStartSpeaking(langHint);
      });
      btn.addEventListener('keyup', (e) => {
        if (e.key === ' ' || e.key === 'Enter') wtStopSpeaking();
      });
    }

    bindPTT(nativeSpeakBtn, 'native');
    bindPTT(italianSpeakBtn, 'italian');
    setWalkieTalkieButtonsDisabled(true);

    // Fetch native language from server config and update button labels.
    fetch('/api/ciao-config')
      .then(r => r.json())
      .then(cfg => {
        const lang = cfg?.nativeLanguage || 'Native';
        window.USER_NATIVE_LANGUAGE = lang;
        if (nativeSpeakBtn) {
          // Update only the label span to preserve the SVG icon.
          const labelEl = nativeSpeakBtn.querySelector('.wt-label');
          if (labelEl) labelEl.textContent = `Hold to speak ${lang}`;
          nativeSpeakBtn.setAttribute('aria-label', `Hold to speak in ${lang}`);
        }
      })
      .catch(() => {});
  }

  // Initial UI state
  setDisabled(stopBtn, true);
  if (IS_WALKIE_TALKIE) setWalkieTalkieButtonsDisabled(true);

})();
