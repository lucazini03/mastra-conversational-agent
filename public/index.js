const startBtn = document.getElementById('startBtn');
  const stopBtn = document.getElementById('stopBtn');
  const testBtn = document.getElementById('testBtn');
  const sendBtn = document.getElementById('sendBtn');
  const chatInput = document.getElementById('chatInput');
  const assistantPicker = document.getElementById('assistantPicker');
  const statusEl = document.getElementById('status');
  const sessionHintEl = document.getElementById('sessionHint');
  const conversationTimerEl = document.getElementById('conversationTimer');
  const connectionTimerEl = document.getElementById('connectionTimer');
  const transcriptLog = document.getElementById('transcriptLog');
  const systemLog = document.getElementById('systemLog');
  const transcriptEmpty = document.getElementById('transcriptEmpty');
  const systemEmpty = document.getElementById('systemEmpty');
  const soundBars = document.getElementById('soundBars');
  const robotRing = document.getElementById('robotRing');
  const robotRing2 = document.getElementById('robotRing2');
  const summaryDocInput = document.getElementById('summaryDocInput');
  const ragDocInput = document.getElementById('ragDocInput');
  const summaryDocName = document.getElementById('summaryDocName');
  const ragDocName = document.getElementById('ragDocName');
  const pageAssistantId = document.body?.dataset?.assistantId;
  const hasDebugUi = Boolean(assistantPicker && transcriptLog && systemLog);
  const statusBaseClass = statusEl?.classList.contains('status') ? 'status' : 'status-text';

      const ASSISTANTS = [
        { id: 'professor', label: 'Il Professore' },
        { id: 'interview_coach', label: 'Intervista di lavoro' },
        { id: 'study_tutor', label: 'Tutor per lo studio' },
        { id: 'audioguide', label: 'Audioguida' },
        { id: 'immigration_assistant', label: 'Immigrazione' },
        { id: 'language_tutor', label: 'Tutor linguistico' },
      ];

      let selectedAssistantId =
        typeof pageAssistantId === 'string' && pageAssistantId.trim()
          ? pageAssistantId.trim()
          : ASSISTANTS[0].id;
      let ws = null;
      let micVad = null;
      let sessionReady = false;
      let isSpeaking = false;
      let conversationStartAt = null;
      let connectionStartAt = null;
      let conversationTimerInterval = null;
      let connectionTimerInterval = null;

      const PLAYBACK_SAMPLE_RATE = 24000;
      const MIC_SAMPLE_RATE = 16000;
      const SILERO_POSITIVE_SPEECH_THRESHOLD = 0.9;
      const SILERO_NEGATIVE_SPEECH_THRESHOLD = 0.4;
      const SILERO_MIN_SPEECH_MS = 180;
      const TTS_SUPPRESSION_AFTER_INTERRUPTION_MS = 900; // this is  
      const VAD_PREROLL_MS = 280;
      const VAD_PREROLL_MAX_BYTES = Math.floor((MIC_SAMPLE_RATE * 2 * VAD_PREROLL_MS) / 1000);
      let playbackCtx = null;
      let nextPlaybackTime = 0;
      const activePlaybackSources = new Set();
      const TRANSCRIPT_MERGE_WINDOW_MS = 1400;
      let lastTranscriptEntry = null;
      let ttsSuppressionUntilMs = 0;
      let ttsSuppressionDropCount = 0;
      let isVadActive = false;
      let vadPrerollFrames = [];
      let vadPrerollBytes = 0;

      // ── Robot animation ──────────────────────────────────────────────────────
      function setRobotSpeaking(speaking) {
        isSpeaking = speaking;
        soundBars?.classList.toggle('active', speaking);
        robotRing?.classList.toggle('speaking', speaking);
        robotRing2?.classList.toggle('speaking', speaking);

        const mouthPieces = ['m1','m2','m3','m4'];
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
          if (antenna) {
            antenna.style.opacity = '1';
            antenna.style.filter = 'drop-shadow(0 0 4px #38bdf8)';
          }
        } else {
          clearInterval(window._mouthInterval);
          mouthPieces.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            el.style.opacity = '0.5';
          });
          const antenna = document.getElementById('antennaGlow');
          if (antenna) {
            antenna.style.opacity = '0.9';
            antenna.style.filter = '';
          }
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

      // ── Helpers ──────────────────────────────────────────────────────────────
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
        label.textContent = role === 'user' ? 'You' : 'MemorAIz';
        const body = document.createElement('div');
        body.className = 'transcript-text';
        body.textContent = text;
        wrap.appendChild(label);
        wrap.appendChild(body);
        transcriptLog.appendChild(wrap);
        transcriptLog.scrollTop = transcriptLog.scrollHeight;
        return { wrap, body };
      }

      function updateTranscriptLine(entry, text) {
        if (!entry?.bodyEl) return;
        entry.bodyEl.textContent = text;
      }

      function logTranscript(role, text) {
        if (!transcriptLog) return;
        const now = Date.now();
        const normalizedText = String(text ?? '').trim();
        if (!normalizedText) return;

        if (
          lastTranscriptEntry &&
          lastTranscriptEntry.role === role &&
          now - lastTranscriptEntry.at <= TRANSCRIPT_MERGE_WINDOW_MS
        ) {
          const merged = mergeTranscriptText(lastTranscriptEntry.text, normalizedText);
          lastTranscriptEntry.text = merged;
          lastTranscriptEntry.at = now;
          updateTranscriptLine(lastTranscriptEntry, merged);
          transcriptLog.scrollTop = transcriptLog.scrollHeight;
          return;
        }

        const { wrap, body } = createTranscriptLine(role, normalizedText);
        lastTranscriptEntry = { role, text: normalizedText, at: now, wrap, bodyEl: body };
      }

      function logSystem(text, cls = '') {
        if (!systemLog) {
          if (sessionHintEl) setHint(String(text));
          return;
        }
        if (systemEmpty) systemEmpty.style.display = 'none';
        const el = document.createElement('div');
        el.className = `log-line ${cls}`;
        el.textContent = text;
        systemLog.appendChild(el);
        systemLog.scrollTop = systemLog.scrollHeight;
      }

      function logRag(text) {
        if (!systemLog) {
          if (sessionHintEl) setHint(String(text));
          return;
        }
        if (systemEmpty) systemEmpty.style.display = 'none';
        const el = document.createElement('div');
        el.className = 'log-line rag';
        el.innerHTML = `<span class="rag-badge">RAG</span>${text}`;
        systemLog.appendChild(el);
        systemLog.scrollTop = systemLog.scrollHeight;
      }

      function logVad(source, message) {
        if (!systemLog) return;
        if (systemEmpty) systemEmpty.style.display = 'none';
        const normalized = source === 'gemini' ? 'gemini' : 'silero';
        const className = normalized === 'gemini' ? 'vad-gemini' : 'vad-silero';
        const badge = normalized === 'gemini' ? 'GEMINI VAD' : 'SILERO VAD';

        const el = document.createElement('div');
        el.className = `log-line ${className}`;
        el.innerHTML = `<span class="vad-badge ${normalized}">${badge}</span>${message}`;
        systemLog.appendChild(el);
        systemLog.scrollTop = systemLog.scrollHeight;
      }

      function setStatus(text, cls = '') {
        if (!statusEl) return;
        statusEl.textContent = text;
        statusEl.className = `${statusBaseClass} ${cls}`;
      }

      function formatConversationDuration(ms) {
        const totalSeconds = Math.max(0, Math.floor(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
      }

      function updateConversationTimer() {
        if (!conversationTimerEl) return;
        if (conversationStartAt === null) {
          conversationTimerEl.textContent = '00:00';
          return;
        }
        conversationTimerEl.textContent = formatConversationDuration(Date.now() - conversationStartAt);
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
        if (conversationTimerEl) conversationTimerEl.textContent = '00:00';
      }

      function updateConnectionTimer() {
        if (!connectionTimerEl) return;
        if (connectionStartAt === null) {
          connectionTimerEl.textContent = '00:00';
          return;
        }
        connectionTimerEl.textContent = formatConversationDuration(Date.now() - connectionStartAt);
      }

      function startConnectionTimer() {
        connectionStartAt = Date.now();
        updateConnectionTimer();
        if (connectionTimerInterval) clearInterval(connectionTimerInterval);
        connectionTimerInterval = setInterval(updateConnectionTimer, 1000);
      }

      function stopConnectionTimer() {
        if (connectionTimerInterval) {
          clearInterval(connectionTimerInterval);
          connectionTimerInterval = null;
        }
        connectionStartAt = null;
        if (connectionTimerEl) connectionTimerEl.textContent = '00:00';
      }

      function setAssistantButtonsDisabled(disabled) {
        if (!assistantPicker) return;
        assistantPicker.querySelectorAll('button').forEach(b => {
          b.disabled = disabled;
        });
      }

      function setDocumentInputsDisabled(disabled) {
        setDisabled(summaryDocInput, disabled);
        setDisabled(ragDocInput, disabled);
      }

      async function uploadDocumentConfig() {
        const summaryFile = summaryDocInput?.files?.[0] ?? null;
        const ragFiles = ragDocInput?.files ? Array.from(ragDocInput.files) : [];

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

      function getSelectedAssistantLabel() {
        return ASSISTANTS.find(a => a.id === selectedAssistantId)?.label ?? 'Assistant';
      }

      function renderAssistantButtons() {
        if (!assistantPicker) return;
        assistantPicker.innerHTML = '';
        ASSISTANTS.forEach(assistant => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = `assistant-btn${assistant.id === selectedAssistantId ? ' active' : ''}`;
          btn.textContent = assistant.label;
          btn.addEventListener('click', () => {
            if (ws) return;
            selectedAssistantId = assistant.id;
            renderAssistantButtons();
            setStatus(`Selected: ${assistant.label}`);
          });
          assistantPicker.appendChild(btn);
        });
      }

      // ── Audio helpers ─────────────────────────────────────────────────────────
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

      function suppressTtsForInterruption(source, message, durationMs = TTS_SUPPRESSION_AFTER_INTERRUPTION_MS) {
        stopAndClearPlayback();
        ttsSuppressionUntilMs = Math.max(ttsSuppressionUntilMs, Date.now() + durationMs);
        ttsSuppressionDropCount = 0;
        logVad(source, message);
      }

      function shouldDropIncomingTtsChunk() {
        if (Date.now() < ttsSuppressionUntilMs) {
          ttsSuppressionDropCount += 1;
          return true;
        }

        if (ttsSuppressionUntilMs !== 0 && ttsSuppressionDropCount > 0) {
          logSystem(`TTS guard: scartati ${ttsSuppressionDropCount} chunk residui dopo interruzione.`);
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

      function resetVadPrerollBuffer() {
        vadPrerollFrames = [];
        vadPrerollBytes = 0;
      }

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
        if (!ws || ws.readyState !== WebSocket.OPEN) {
          resetVadPrerollBuffer();
          return;
        }

        for (const frame of vadPrerollFrames) {
          sendMicChunkInt16(frame);
        }
        resetVadPrerollBuffer();
      }

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
            // Stop TTS playback immediately (zero latency, local).
            if (activePlaybackSources.size > 0) {
              suppressTtsForInterruption(
                'silero',
                'Speech reale rilevato da Silero: riproduzione interrotta.',
              );
            }
            // Signal to Gemini that a user turn has started.
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'activity_start' }));
            }
            // Send a short preroll so the first syllable is not clipped.
            flushVadPreroll();
          },
          onSpeechEnd: (_audio) => {
            isVadActive = false;
            // Signal to Gemini that the user turn has ended.
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.send(JSON.stringify({ type: 'activity_end' }));
            }
            resetVadPrerollBuffer();
          },
          onFrameProcessed: (_probabilities, audioFrame) => {
            if (!ws || ws.readyState !== WebSocket.OPEN) {
              resetVadPrerollBuffer();
              return;
            }
            const int16 = float32ToInt16(audioFrame);
            if (isVadActive) {
              sendMicChunkInt16(int16);
              return;
            }
            pushVadPrerollFrame(int16);
          },
        });
        await micVad.start();
      }

      function sendTextPrompt() {
        if (!ws || ws.readyState !== WebSocket.OPEN || !chatInput) return;
        const text = chatInput.value.trim();
        if (!text) return;
        stopAndClearPlayback();
        ws.send(JSON.stringify({ type: 'text_prompt', text }));
        chatInput.value = '';
      }

      async function startSession() {
        if (ws) return;
        sessionReady = false;
        setDisabled(startBtn, true);
        setStatus(hasDebugUi ? 'Preparing documents...' : 'Preparazione', '');
        if (!hasDebugUi) {
          setHint('Caricamento documenti in corso, attendi un momento...');
        }

        let uploadResult;
        try {
          uploadResult = await uploadDocumentConfig();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (hasDebugUi) {
            logSystem(`Document upload error: ${message}`, 'error');
            setStatus('Document upload failed.', 'error');
          } else {
            setStatus('Errore', 'error');
            setHint(`Upload documenti non riuscito: ${message}`);
          }
          setDisabled(startBtn, false);
          return;
        }

        if (uploadResult.documentConfigId) {
          if (hasDebugUi) {
            const mode =
              uploadResult.summaryCount > 0 && uploadResult.ragCount > 0
                ? `summary=${uploadResult.summaryCount}, rag=${uploadResult.ragCount}`
                : uploadResult.summaryCount > 0
                  ? `summary=${uploadResult.summaryCount} (reused for rag=${uploadResult.effectiveRagCount})`
                  : `rag=${uploadResult.ragCount} (summary disabled)`;
            logSystem(`Documents configured: ${mode}`);
          } else {
            setHint(
              `Documenti elaborati con successo — riepilogo: ${uploadResult.summaryCount} file, RAG: ${uploadResult.effectiveRagCount} fonte/i. Connessione in corso...`,
            );
          }
        } else {
          if (hasDebugUi) {
            logSystem('No summary or RAG documents selected. Starting without document context.');
          } else {
            setHint('Nessun documento caricato: la sessione partirà in modalità conversazione libera, senza contesto specifico.');
          }
        }

        setStatus(hasDebugUi ? 'Connecting...' : 'Connessione in corso...', '');

        const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${scheme}//${window.location.host}`);
        ws.binaryType = 'arraybuffer';

        ws.onopen = async () => {
          try {
            await startMicCapture();
            ws.send(
              JSON.stringify({
                type: 'start_session',
                assistantId: selectedAssistantId,
                documentConfigId: uploadResult.documentConfigId,
              }),
            );
            startConversationTimer();
            setDisabled(stopBtn, false);
            setDisabled(testBtn, false);
            setDisabled(sendBtn, false);
            setDisabled(chatInput, false);
            setAssistantButtonsDisabled(true);
            setDocumentInputsDisabled(true);
            if (hasDebugUi) {
              setStatus(`Connecting to ${getSelectedAssistantLabel()}...`);
              logSystem(`Microphone ready. Waiting for ${getSelectedAssistantLabel()}...`);
            } else {
              setStatus('Connesso', 'connected');
              setHint('Sessione live attiva — parla liberamente o digita un messaggio. Il microfono è acceso.');
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (hasDebugUi) {
              logSystem(`Microphone error: ${msg}`, 'error');
            } else {
              setStatus('Errore', 'error');
              setHint(`Microfono non disponibile: ${msg}`);
            }
            stopSession();
          }
        };

        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') return;
          let msg;
          try { msg = JSON.parse(event.data); } catch {
            if (hasDebugUi) logSystem(event.data);
            return;
          }

          if (msg.type === 'status') {
            const txt = String(msg.message ?? '');
            if (txt.includes('Connected!') && !sessionReady) {
              sessionReady = true;
              if (hasDebugUi) {
                logSystem('Session started.', '');
                setStatus('Connected', 'connected');
              } else {
                setStatus('Connesso', 'connected');
                setHint("L'assistente del professore è pronto. Puoi iniziare a rispondere alle domande o porre chiarimenti.");
              }
              startConnectionTimer();
            } else if (txt.includes('Connessione ripristinata')) {
              startConnectionTimer();
              setStatus(hasDebugUi ? txt : 'Connesso', 'connected');
              if (!hasDebugUi) {
                setHint('Connessione WebSocket ripristinata correttamente — la sessione riprende normalmente.');
              }
            } else {
              setStatus(txt, txt.toLowerCase().includes('error') ? 'error' : '');
            }
          }

          if (msg.type === 'error') {
            if (hasDebugUi) {
              setStatus('Connection failed.', 'error');
              logSystem(`Error: ${msg.message}`, 'error');
            } else {
              setStatus('Errore', 'error');
              setHint(`Sessione non disponibile: ${msg.message ?? 'errore sconosciuto'}`);
            }
            stopSession();
          }

          if (msg.type === 'transcript') {
            logTranscript(msg.role, msg.text);
            if (msg.role === 'model') setStatus(hasDebugUi ? 'Speaking...' : 'Sta parlando', 'speaking');
            if (msg.role === 'user') setStatus(hasDebugUi ? 'Listening...' : 'Ti ascolta', 'connected');
          }

          if (msg.type === 'rag_tool_called') {
            const sourceList = Array.isArray(msg.sources) ? msg.sources : [];
            const scoreList = Array.isArray(msg.scores) ? msg.scores : [];
            const sourceText = sourceList.length > 0 ? sourceList.join(', ') : 'no sources';
            const scoreText = scoreList.slice(0, 3).map(s => `${s.file}=${Number(s.score).toFixed(3)}`).join(' | ');
            if (hasDebugUi) {
              logRag(scoreText ? `query="${msg.query}" | ${sourceText} | ${scoreText}` : `query="${msg.query}" | ${sourceText}`);
            } else {
              setHint(`Ricerca semantica completata — trovati risultati in ${sourceList.length} fonte/i. L'assistente sta elaborando la risposta.`);
            }
          }

          if (msg.type === 'session_cost_summary') {
            const inputTokens = Number(msg.inputTokens ?? 0).toLocaleString();
            const outputTokens = Number(msg.outputTokens ?? 0).toLocaleString();
            const hasPricing = Boolean(msg.pricingConfigured);
            const totalCost = hasPricing ? `$${Number(msg.estimatedCostUsd ?? 0).toFixed(6)}` : 'N/A';
            if (hasDebugUi) {
              logSystem(
                `Cost summary — In: ${inputTokens} | Out: ${outputTokens} | Est: ${totalCost}`,
                'cost'
              );
              setStatus(hasPricing ? `Session cost: ${totalCost}` : 'Session ended.', '');
            } else {
              setHint(`Sessione terminata. Costo stimato per questa conversazione: ${hasPricing ? totalCost : 'non configurata'}. Puoi ricaricare i documenti e avviare una nuova sessione.`);
              setStatus('Pronto', '');
            }
          }

          if (msg.type === 'vad_event') {
            const source = String(msg.source ?? 'gemini').toLowerCase();
            const detail = String(msg.message ?? 'Evento VAD rilevato lato modello.');
            if (source === 'gemini') {
              suppressTtsForInterruption('gemini', detail, 1200);
            } else {
              logVad('silero', detail);
            }
          }

          if (msg.type === 'tts_audio' && msg.data) {
            enqueueTtsAudio(msg.data);
          }
        };

        ws.onerror = () => {
          if (hasDebugUi) {
            logSystem('WebSocket error.', 'error');
          } else {
            setStatus('Errore', 'error');
            setHint('Errore di connessione WebSocket. Controlla che il server sia attivo e riprova.');
          }
        };

        ws.onclose = () => {
          stopAndClearPlayback();
          stopMicCapture();
          stopConversationTimer();
          stopConnectionTimer();
          setRobotSpeaking(false);
          sessionReady = false;
          ws = null;
          setDisabled(startBtn, false);
          setDisabled(stopBtn, true);
          setDisabled(testBtn, true);
          setDisabled(sendBtn, true);
          setDisabled(chatInput, true);
          setAssistantButtonsDisabled(false);
          setDocumentInputsDisabled(false);
          setStatus(hasDebugUi ? 'Idle' : 'Pronto', '');
          if (hasDebugUi) {
            logSystem('Session ended.');
          } else {
            setHint('Sessione terminata. Puoi caricare nuovi documenti e avviare una nuova sessione quando vuoi.');
          }
        };
      }

      function stopSession() {
        if (!ws) return;
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'end_session' }));
          ws.close();
        } else { ws = null; }
        stopMicCapture();
      }

      startBtn?.addEventListener('click', () => void startSession());
      stopBtn?.addEventListener('click', () => stopSession());
      testBtn?.addEventListener('click', () => {
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'simulate_disconnect' }));
      });
      sendBtn?.addEventListener('click', () => sendTextPrompt());
      chatInput?.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendTextPrompt(); } });

      summaryDocInput?.addEventListener('change', () => {
        const file = summaryDocInput.files?.[0];
        if (!summaryDocName) return;
        summaryDocName.textContent = file ? file.name : 'Nessun file selezionato';
        summaryDocName.classList.toggle('visible', Boolean(file));
      });

      ragDocInput?.addEventListener('change', () => {
        const files = ragDocInput.files ? Array.from(ragDocInput.files) : [];
        if (!ragDocName) return;
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
      });

      renderAssistantButtons();
    