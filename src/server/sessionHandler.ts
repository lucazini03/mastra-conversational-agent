// src/server/sessionHandler.ts
//
// One instance of this class is created per browser WebSocket connection.
// It owns a ProfessorAgent and pipes audio in both directions:
//   Browser mic PCM → GeminiLive → Browser speaker PCM
//
// Protocol (binary frames = audio, text frames = JSON control messages):
//   Browser → Server  { type: 'start_session' }
//   Browser → Server  { type: 'end_session' }
//   Browser → Server  ArrayBuffer (raw Int16 PCM audio chunks, 16kHz mono)
//   Server  → Browser { type: 'transcript', role: 'user'|'model', text: string }
//   Server  → Browser { type: 'status',     message: string }
//   Server  → Browser { type: 'error',      message: string }
//   Server  → Browser ArrayBuffer (raw Int16 PCM audio from Gemini, 24kHz mono)

import { WebSocket, type RawData } from 'ws';
import { createProfessorAgent, type ProfessorAgent } from '../agent/professorFactory.js';

export class SessionHandler {
  private ws: WebSocket;
  private professor: ProfessorAgent | null = null;
  private sessionId: string;
  private isStarting = false;

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

      if (typeof normalized === 'string') {
        this.handleControlMessage(normalized);
        return;
      }

      if (!this.isLikelyBinaryAudio(normalized)) {
        this.handleControlMessage(normalized.toString());
        return;
      }

      // Binary frame = raw PCM audio from the browser microphone
      this.handleAudioChunk(normalized);
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

  private isLikelyBinaryAudio(buf: Buffer): boolean {
    // If the first byte is '{' (0x7B) it's JSON; otherwise treat as audio
    return buf[0] !== 0x7b;
  }

  private normalizeIncomingMessage(data: RawData): Buffer | string {
    if (typeof data === 'string') return data;
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data);
    return data;
  }

  // ─── Control Messages ───────────────────────────────────────────────────────

  private async handleControlMessage(raw: string) {
    let msg: { type: string };
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

          const buffer =
            typeof chunk === 'string'
              ? Buffer.from(chunk)
              : Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk);

          // Send raw PCM as a binary frame
          this.ws.send(buffer);
        });

        audioStream.on('error', (streamErr: Error) => {
          console.warn(`[${this.sessionId}] Speaker stream error:`, streamErr.message);
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
      this.geminiSpeakFirst(voice, 'Ciao! Sono pronto ad aiutarti.');

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
      // Try the documented getWebSocket() accessor on connectionManager first
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

      // Gemini 3.1 Live API: inject text as a realtime input turn.
      // The model will respond to this and speak first.
      const message = JSON.stringify({
        realtimeInput: {
          text,
        },
      });

      geminiWs.send(message);
      console.log(`[${this.sessionId}] geminiSpeakFirst: sent realtimeInput text → "${text}"`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.sessionId}] geminiSpeakFirst failed:`, msg);
    }
  }

  // ─── Audio Routing ──────────────────────────────────────────────────────────

  private async handleAudioChunk(buf: Buffer) {
    if (!this.professor) return;
    if (this.ws.readyState !== WebSocket.OPEN) return;

    try {
      // Convert the raw buffer to Int16Array (matches Gemini's expected format)
      const int16 = new Int16Array(buf.buffer, buf.byteOffset, buf.byteLength / 2);
      await this.professor.voice.send(int16);
    } catch (err) {
      // Don't crash on individual chunk send errors (common if connection drops)
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('closed')) {
        console.warn(`[${this.sessionId}] Audio send error:`, msg);
      }
    }
  }

  // ─── Cleanup ────────────────────────────────────────────────────────────────

  private async cleanup() {
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