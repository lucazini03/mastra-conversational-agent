// src/server/index.ts
//
// HTTP server:  serves the browser demo UI (public/)
// WebSocket server:  handles one STS session per connected client

import 'dotenv/config';
import express from 'express';
import { createServer, type IncomingMessage } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { SessionHandler } from './sessionHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// ── Security: allowed WebSocket origins ──────────────────────────────────────
// In production set WS_ALLOWED_ORIGINS to a comma-separated list of allowed
// origins (e.g. "https://myapp.example.com"). When unset, only same-origin
// requests (origin matching the server's own host) are accepted.
const allowedOriginsEnv = process.env.WS_ALLOWED_ORIGINS?.split(',').map(o => o.trim()).filter(Boolean);

function isOriginAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  // Non-browser clients (curl, Postman) don't send an Origin header.
  // Allow them through — they are not vulnerable to CSWSH.
  if (!origin) return true;

  if (allowedOriginsEnv && allowedOriginsEnv.length > 0) {
    return allowedOriginsEnv.includes(origin);
  }

  // Default: allow same-origin only
  const host = req.headers.host;
  if (!host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host;
  } catch {
    return false;
  }
}

// ── Security: per-IP WebSocket rate limiting ─────────────────────────────────
const WS_MAX_CONNECTIONS_PER_IP = parseInt(process.env.WS_MAX_CONNECTIONS_PER_IP ?? '5', 10);
const ipConnectionCounts = new Map<string, number>();

function getClientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0].trim();
  return req.socket.remoteAddress ?? 'unknown';
}

// ── Express (serves the browser UI) ──────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// Security headers
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
  next();
});

// Serve the static browser demo from /public
const publicDir = join(__dirname, '../../public');
app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ── WebSocket server ──────────────────────────────────────────────────────────
const wss = new WebSocketServer({
  server: httpServer,
  verifyClient: ({ req }, callback) => {
    // Origin validation (prevents Cross-Site WebSocket Hijacking)
    if (!isOriginAllowed(req)) {
      console.warn(`[WS] Rejected connection from disallowed origin: ${req.headers.origin}`);
      callback(false, 403, 'Forbidden: origin not allowed');
      return;
    }

    // Per-IP rate limiting
    const ip = getClientIp(req);
    const current = ipConnectionCounts.get(ip) ?? 0;
    if (current >= WS_MAX_CONNECTIONS_PER_IP) {
      console.warn(`[WS] Rate limit exceeded for IP ${ip} (${current}/${WS_MAX_CONNECTIONS_PER_IP})`);
      callback(false, 429, 'Too many connections');
      return;
    }

    callback(true);
  },
});

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
  const clientIp = getClientIp(req);
  console.log(`[${sessionId}] New connection from ${clientIp}`);

  // Track per-IP connection count
  ipConnectionCounts.set(clientIp, (ipConnectionCounts.get(clientIp) ?? 0) + 1);

  // Each connection gets its own isolated handler (and its own GeminiLiveVoice instance)
  const handler = new SessionHandler(ws, sessionId);
  activeSessions.set(sessionId, handler);

  ws.on('close', () => {
    activeSessions.delete(sessionId);
    const count = ipConnectionCounts.get(clientIp) ?? 1;
    if (count <= 1) {
      ipConnectionCounts.delete(clientIp);
    } else {
      ipConnectionCounts.set(clientIp, count - 1);
    }
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
