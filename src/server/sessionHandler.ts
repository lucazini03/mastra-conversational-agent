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
//   Server  → Browser { type: 'transcript', role: 'user'|'model', text: string }
//   Server  → Browser { type: 'status',     message: string }
//   Server  → Browser { type: 'error',      message: string }
//   Server  → Browser { type: 'tts_audio',  data: string }    ← base64 Int16 PCM, 24kHz mono

import { WebSocket, type RawData } from 'ws';
import { createProfessorAgent, type ProfessorAgent } from '../agent/professorFactory.js';

export class SessionHandler {
  private ws: WebSocket;
  private professor: ProfessorAgent | null = null;
  private sessionId: string;
  private isStarting = false;
  private pendingMicByte: Buffer | null = null;
  private pendingTtsByte: Buffer | null = null;

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

      // All messages are JSON text frames — audio_chunk carries base64 payload
      if (typeof normalized === 'string') {
        this.handleControlMessage(normalized);
        return;
      }

      // Some ws clients deliver text frames as Buffer, so decode and parse JSON.
      const asString = normalized.toString();
      if (asString[0] === '{') {
        this.handleControlMessage(asString);
      }
    });

    this.ws.on('close', () => {
      console.log(`[${this.sessionId}] WebSocket closed — cleaning up`);
      this.cleanup();
    });

    this.ws.on('error', (err) => {
      console.error(`[${this.sessionId}] WebSocket error:`, err.message);
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
    let msg: { type: string; data?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn(`[${this.sessionId}] Non-JSON control message:`, raw);
      return;
    }

    switch (msg.type) {
      case 'start_session':
        await this.startSession();
        break;
      case 'end_session':
        await this.cleanup();
        break;
      case 'audio_chunk':
        // Browser sends mic audio as base64-encoded Int16 PCM (16kHz mono)
        if (!msg.data || !this.professor) break;

        {
          let decoded = Buffer.from(msg.data, 'base64');

          // Preserve alignment across chunk boundaries to avoid dropping bytes.
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

    this.isStarting = true;

    let createdProfessor: ProfessorAgent | null = null;

    try {
      this.sendStatus('Connecting to MemorAIz Assistant...');

      // Create a fresh, isolated agent for this user
      createdProfessor = createProfessorAgent();
      const { voice } = createdProfessor;

      // ── Listen for audio coming BACK from Gemini → forward to browser ──────
      voice.on('speaker', (audioStream: NodeJS.ReadableStream) => {
        audioStream.on('data', (chunk: Buffer | Uint8Array | string) => {
          if (this.ws.readyState !== WebSocket.OPEN) return;

          let buf: Buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk)
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);

          // Preserve alignment across chunk boundaries to avoid dropping bytes.
          if (this.pendingTtsByte) {
            buf = Buffer.concat([this.pendingTtsByte, buf]);
            this.pendingTtsByte = null;
          }

          if (buf.byteLength % 2 !== 0) {
            this.pendingTtsByte = buf.slice(buf.byteLength - 1);
            buf = buf.slice(0, buf.byteLength - 1);
          }

          if (buf.byteLength === 0) return;

          // Send as JSON+base64 so the browser decodes at the correct
          // 24kHz sample rate with no format ambiguity
          this.sendJSON({ type: 'tts_audio', data: buf.toString('base64') });
        });

        audioStream.on('error', (streamErr: Error) => {
          console.warn(`[${this.sessionId}] Speaker stream error:`, streamErr.message);
        });

        audioStream.on('end', () => {
          this.pendingTtsByte = null;
        });
      });

      // ── Listen for transcriptions (both user and model text) ───────────────
      voice.on('writing', ({ text, role }: { text: string; role: string }) => {
        this.sendJSON({ type: 'transcript', role, text });
        console.log(`[${this.sessionId}] ${role}: ${text}`);
      });

      // ── Forward any errors to the browser ─────────────────────────────────
      voice.on('error', (err: { message: string; code?: string; details?: unknown }) => {
        console.error(`[${this.sessionId}] Voice error:`, err);
        this.sendJSON({ type: 'error', message: err.message });
      });

      // Establish the WebSocket to Google Live API
      await voice.connect();

      // Mark session as active only after the voice connection is established.
      this.professor = createdProfessor;

      this.sendStatus('Connected! MemorAIz Assistant is ready.');

      // ── Gemini 3.1: trigger the model to speak first ───────────────────────
      // Gemini 3.1 rejects `client_content` (used by voice.speak()) mid-session.
      // The correct approach is `realtimeInput` with a `text` field, sent raw
      // over the underlying WebSocket that Mastra exposes via connectionManager.
      this.geminiSpeakFirst(voice, `Sei l'assistente di MemorAIz.
      Presentati, poi chiedi all'utente come puoi aiutarlo oggi.`);

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Failed to start session:`, message);
      this.sendStatus(`Connection failed: ${message}`);
      this.sendJSON({ type: 'error', message: `Failed to connect: ${message}` });
      this.professor = null;
      if (createdProfessor) {
        await createdProfessor.destroy();
      }
    } finally {
      this.isStarting = false;
    }
  }

  // ─── Gemini 3.1 "speak first" ───────────────────────────────────────────────
  //
  // voice.speak() sends `client_content`, which Gemini 3.1 rejects with 1007.
  // Instead we send `realtimeInput: { text }` directly on the raw WebSocket.
  // Mastra keeps the underlying WS on voice.connectionManager (accessible via
  // getWebSocket()), which we reach through the `any` cast.
  //
  private geminiSpeakFirst(voice: any, text: string) {
    try {
      const geminiWs: WebSocket | undefined =
        voice?.connectionManager?.getWebSocket?.() ??
        voice?.connectionManager?.ws ??
        voice?.ws;

      if (!geminiWs) {
        console.warn(`[${this.sessionId}] geminiSpeakFirst: could not find underlying WebSocket`);
        return;
      }

      if (geminiWs.readyState !== WebSocket.OPEN) {
        console.warn(`[${this.sessionId}] geminiSpeakFirst: WebSocket not open (state=${geminiWs.readyState})`);
        return;
      }

      const message = JSON.stringify({ realtimeInput: { text } });
      geminiWs.send(message);
      console.log(`[${this.sessionId}] geminiSpeakFirst: sent realtimeInput text → "${text}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.sessionId}] geminiSpeakFirst failed:`, msg);
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  private async cleanup() {
    this.pendingMicByte = null;
    this.pendingTtsByte = null;

    if (this.professor) {
      await this.professor.destroy();
      this.professor = null;
      console.log(`[${this.sessionId}] Professor agent destroyed`);
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private sendJSON(obj: object) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(obj));
    }
  }

  private sendStatus(message: string) {
    this.sendJSON({ type: 'status', message });
  }
}