// src/client/cli.ts
//
// A terminal-based test client. Run `npm run test:cli` to test the
// professor agent directly from the command line using your microphone.
// No browser required — good for quick local tests.
//
// Requires: npm install @mastra/node-audio
// (needs a working microphone and speaker on the machine)

import 'dotenv/config';
import { PassThrough } from 'node:stream';
import chalk from 'chalk';
import { getMicrophoneStream, playAudio } from '@mastra/node-audio';
import { createProfessorAgent } from '../agent/professorFactory.js';

console.log(chalk.yellow('\n  MemorAIz assistant — CLI Test Mode'));
console.log(chalk.yellow('  ─────────────────────────────'));
console.log(chalk.gray('  Speak into your microphone. Press Ctrl+C to quit.\n'));

async function main() {
  const { voice, destroy } = createProfessorAgent();

  // ── Wire up audio playback from Gemini ───────────────────────────────────
  // Gemini may emit many short speaker streams. Playing each one separately
  // can cause overlap/gaps, so we merge everything into one continuous stream.
  let speakerOut: PassThrough | null = null;
  let speakerPlayerActive = false;
  let pendingSpeakerByte: Buffer | null = null;

  function ensureSpeakerPlayer() {
    if (speakerPlayerActive && speakerOut) return;

    speakerOut = new PassThrough();
    try {
      playAudio(speakerOut);
      speakerPlayerActive = true;
    } catch (err) {
      speakerPlayerActive = false;
      speakerOut = null;
      console.error(chalk.red('\n  Playback error:'), err instanceof Error ? err.message : String(err));
    }
  }

  voice.on('speaker', (audioStream: NodeJS.ReadableStream) => {
    ensureSpeakerPlayer();

    audioStream.on('data', (chunk: Buffer | Uint8Array | string) => {
      if (!speakerOut) return;

      let buf =
        typeof chunk === 'string'
          ? Buffer.from(chunk)
          : Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(chunk);

      // Keep Int16 sample alignment across chunk boundaries.
      if (pendingSpeakerByte) {
        buf = Buffer.concat([pendingSpeakerByte, buf]);
        pendingSpeakerByte = null;
      }

      if (buf.byteLength % 2 !== 0) {
        pendingSpeakerByte = buf.slice(buf.byteLength - 1);
        buf = buf.slice(0, buf.byteLength - 1);
      }

      if (buf.byteLength > 0) {
        speakerOut.write(buf);
      }
    });

    audioStream.on('error', (err: Error) => {
      console.warn(chalk.yellow('\n  Speaker stream error:'), err.message);
    });
  });

  // ── Print live transcripts to terminal ─────────────────────────────────────
  voice.on('writing', ({ text, role }: { text: string; role: string }) => {
    if (role === 'user') {
      process.stdout.write(chalk.green(`\n  You: ${text}`));
    } else {
      process.stdout.write(chalk.blue(`\n  MemorAIz: ${text}`));
    }
  });

  voice.on('error', (err: { message: string; code?: string; details?: unknown }) => {
    console.error(chalk.red('\n  Voice error:'), err.message);
  });


    // ── Connect and greet ───────────────────────────────────────────────────────
  process.stdout.write(chalk.gray('  Connecting to Gemini Live...'));
  await voice.connect();
  console.log(chalk.green(' ✓ Connected!\n'));

  // Gemini 3.1: usa realtimeInput.text invece di client_content (voice.speak)
  const geminiWs =
    (voice as any)?.connectionManager?.getWebSocket?.() ??
    (voice as any)?.connectionManager?.ws ??
    (voice as any)?.ws;

  if (geminiWs?.readyState === 1) {
    geminiWs.send(JSON.stringify({
      realtimeInput: {
        text: "Di' ciao e chiedimi come sto."
      }
    }));
  } else {
    console.warn(chalk.yellow('  Warning: could not send opening message'));
  }

  // ── Stream microphone to Gemini ─────────────────────────────────────────────
  const micStream = getMicrophoneStream();
  await voice.send(micStream);

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\n  Arrivederci! Ending session...'));
    pendingSpeakerByte = null;
    if (speakerOut) {
      speakerOut.end();
      speakerOut = null;
    }
    speakerPlayerActive = false;
    await destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(chalk.red('\nFatal error:'), err);
  process.exit(1);
});
