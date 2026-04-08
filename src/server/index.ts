// src/server/index.ts
//
// HTTP server:  serves the browser demo UI (public/)
// WebSocket server:  handles one STS session per connected client

import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { SessionHandler } from './sessionHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Express (serves the browser UI) ──────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// Serve the static browser demo from /public
const publicDir = join(__dirname, '../../public');
app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Stop the other process or run with PORT=<new_port>.\n`);
  } else {
    console.error('WebSocket server error:', err.message);
  }
  process.exit(1);
});

httpServer.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${PORT} is already in use. Stop the other process or run with PORT=<new_port>.\n`);
  } else {
    console.error('HTTP server error:', err.message);
  }
  process.exit(1);
});

// Track active sessions for logging
const activeSessions = new Map<string, SessionHandler>();

wss.on('connection', (ws: WebSocket, req) => {
  const sessionId = randomUUID().slice(0, 8);
  const clientIp = req.socket.remoteAddress ?? 'unknown';
  console.log(`[${sessionId}] New connection from ${clientIp}`);

  // Each connection gets its own isolated handler (and its own GeminiLiveVoice instance)
  const handler = new SessionHandler(ws, sessionId);
  activeSessions.set(sessionId, handler);

  ws.on('close', () => {
    activeSessions.delete(sessionId);
    console.log(`[${sessionId}] Disconnected. Active sessions: ${activeSessions.size}`);
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║    Il Professore — Italian Tutor STS     ║');
  console.log('  ╠══════════════════════════════════════════╣');
  console.log(`  ║  Browser UI:  http://localhost:${PORT}      ║`);
  console.log(`  ║  WebSocket:   ws://localhost:${PORT}        ║`);
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log('  Open the browser URL and click "Start Lesson" to begin.');
  console.log('');
});
