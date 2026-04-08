// src/client/cli.ts
//
// A terminal-based test client. Run `npm run test:cli` to test the
// professor agent directly from the command line using your microphone.
// No browser required — good for quick local tests.
//
// Requires: npm install @mastra/node-audio
// (needs a working microphone and speaker on the machine)

import 'dotenv/config';
import chalk from 'chalk';
import { getMicrophoneStream, playAudio } from '@mastra/node-audio';
import { createProfessorAgent } from '../agent/professorFactory.js';

console.log(chalk.yellow('\n  Il Professore — CLI Test Mode'));
console.log(chalk.yellow('  ─────────────────────────────'));
console.log(chalk.gray('  Speak into your microphone. Press Ctrl+C to quit.\n'));

async function main() {
  const { voice, destroy } = createProfessorAgent();

  // ── Wire up audio playback from Gemini ──────────────────────────────────────
  voice.on('speaker', (audioStream: NodeJS.ReadableStream) => {
    playAudio(audioStream);
  });

  // ── Print live transcripts to terminal ─────────────────────────────────────
  voice.on('writing', ({ text, role }: { text: string; role: string }) => {
    if (role === 'user') {
      process.stdout.write(chalk.green(`\n  You: ${text}`));
    } else {
      process.stdout.write(chalk.blue(`\n  Il Professore: ${text}`));
    }
  });

  voice.on('error', (err: { message: string; code?: string; details?: unknown }) => {
    console.error(chalk.red('\n  Voice error:'), err.message);
  });

  // ── Connect and greet ───────────────────────────────────────────────────────
  process.stdout.write(chalk.gray('  Connecting to Gemini Live...'));
  await voice.connect();
  console.log(chalk.green(' ✓ Connected!\n'));

  // await voice.speak(
  //   "Benvenuto! I am Il Professore, your Italian tutor. " +
  //   "Are you a beginner, intermediate, or advanced student?"
  // );

  // ── Stream microphone to Gemini ─────────────────────────────────────────────
  const micStream = getMicrophoneStream();
  await voice.send(micStream);

  // ── Graceful shutdown ───────────────────────────────────────────────────────
  process.on('SIGINT', async () => {
    console.log(chalk.yellow('\n\n  Arrivederci! Ending session...'));
    await destroy();
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(chalk.red('\nFatal error:'), err);
  process.exit(1);
});
