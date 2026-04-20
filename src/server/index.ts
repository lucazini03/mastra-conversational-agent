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
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomUUID } from 'crypto';
import multer from 'multer';
import { SessionHandler } from './sessionHandler.js';
import { DocumentConfigStore } from './documentConfigStore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const uploadsRootDir = path.join(process.cwd(), 'logs', 'uploads');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
    files: 20,
  },
});

const documentConfigStore = new DocumentConfigStore();

function sanitizeFileName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function saveUploadedFiles(
  files: Express.Multer.File[],
  targetDir: string,
): Promise<string[]> {
  await fs.mkdir(targetDir, { recursive: true });
  const savedPaths: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const safeName = `${String(i + 1).padStart(2, '0')}_${sanitizeFileName(file.originalname)}`;
    const absolutePath = path.join(targetDir, safeName);
    await fs.writeFile(absolutePath, file.buffer);
    savedPaths.push(absolutePath);
  }

  return savedPaths;
}

// ── Express (serves the browser UI) ──────────────────────────────────────────
const app = express();
const httpServer = createServer(app);

// Serve the static browser demo from /public
const publicDir = join(__dirname, '../../public');
app.use(express.static(publicDir));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post(
  '/api/document-config',
  upload.fields([
    { name: 'summaryDocument', maxCount: 1 },
    { name: 'ragDocuments', maxCount: 20 },
  ]),
  async (req, res) => {
    const allFiles = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const summaryUploads = allFiles.summaryDocument ?? [];
    const ragUploads = allFiles.ragDocuments ?? [];

    if (summaryUploads.length === 0 && ragUploads.length === 0) {
      res.status(400).json({ error: 'At least one summary or RAG document is required.' });
      return;
    }

    const uploadId = randomUUID();
    const uploadDir = path.join(uploadsRootDir, uploadId);

    try {
      const summaryFiles = await saveUploadedFiles(summaryUploads, path.join(uploadDir, 'summary'));
      const ragFiles = await saveUploadedFiles(ragUploads, path.join(uploadDir, 'rag'));

      const created = await documentConfigStore.create({
        uploadDir,
        summaryFiles,
        ragFiles,
      });

      const effectiveRagFiles = ragFiles.length > 0 ? ragFiles : [...summaryFiles];

      res.json({
        documentConfigId: created.id,
        summaryCount: summaryFiles.length,
        ragCount: ragFiles.length,
        effectiveRagCount: effectiveRagFiles.length,
      });
    } catch (err) {
      await fs.rm(uploadDir, { recursive: true, force: true }).catch(() => undefined);
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to store uploaded documents.',
      });
    }
  },
);

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
  const handler = new SessionHandler(ws, sessionId, {
    consumeDocumentConfig: (configId: string) => documentConfigStore.consume(configId),
  });
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
