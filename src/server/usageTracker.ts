// src/server/usageTracker.ts
//
// Persistent daily-accumulation usage log.
// File: usage_tracking.log (project root)
//
// The log file maintains one block per calendar day:
//   ════════════════════════════════════════════════════════════════════════════════
//   DATE: YYYY-MM-DD
//   ════════════════════════════════════════════════════════════════════════════════
//   DAILY CUMULATIVE TOTALS:
//   Input Text:    X tokens
//   Input Audio:   X tokens
//   Output Tokens: X tokens
//   Estimated Cost: $X.XXXXXX
//
//   --- SESSIONS ---
//   [timestamp] Key: <full API key>
//   [sessionId8] Input Tokens:  ...
//   [sessionId8] Output Tokens: ...
//   [sessionId8] Est. Cost:     ...
//
// The DAILY CUMULATIVE TOTALS section is updated in-place on every new session.
// Sessions are appended. Previous days are never modified.

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SessionCostSummary } from './sessionCostTracker.js';

const LOG_FILE = path.join(process.cwd(), 'usage_tracking.log');
const HR = '='.repeat(80);

// Serialize writes to avoid read-modify-write races when multiple sessions end
// close together. Without this queue, concurrent writes can drop previous entries.
let writeQueue: Promise<void> = Promise.resolve();

// ── Formatting helpers ────────────────────────────────────────────────────────

function localDateStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function localTimestampStr(): string {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const h = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const s = String(now.getSeconds()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}:${mi}:${s}`;
}

function fmt(n: number): string {
  return n.toLocaleString('en-US');
}

// ── Session entry builder ─────────────────────────────────────────────────────

function buildSessionEntry(
  sessionId: string,
  summary: SessionCostSummary,
  sessionMinutes: number,
  apiKey: string,
  timestamp: string,
): string {
  const id8 = sessionId.slice(0, 8);
  const inputCost = summary.inputCostUsd === null ? 'N/A' : `$${summary.inputCostUsd.toFixed(6)}`;
  const outputCost = summary.outputCostUsd === null ? 'N/A' : `$${summary.outputCostUsd.toFixed(6)}`;
  const estCost = summary.estimatedCostUsd === null ? 'N/A' : `$${summary.estimatedCostUsd.toFixed(6)}`;

  return [
    `[${timestamp}] Key: ${apiKey}`,
    `[${id8}] Input Tokens:  ${fmt(summary.inputTokens)} (${inputCost}) [text=${fmt(summary.inputTextTokens)}, audio=${fmt(summary.inputAudioTokens)}]`,
    `[${id8}] Output Tokens: ${fmt(summary.outputTokens)} (${outputCost}) [text=${fmt(summary.outputTextTokens)}, audio=${fmt(summary.outputAudioTokens)}]`,
    `[${id8}] Est. Cost:     ${estCost} (duration ${sessionMinutes.toFixed(2)} min, usage events ${summary.usageEvents})`,
  ].join('\n');
}

// ── New day block builder ─────────────────────────────────────────────────────

function buildNewDayBlock(
  dateStr: string,
  sessionId: string,
  summary: SessionCostSummary,
  sessionMinutes: number,
  apiKey: string,
  timestamp: string,
): string {
  const cost = summary.estimatedCostUsd ?? 0;
  const sessionEntry = buildSessionEntry(sessionId, summary, sessionMinutes, apiKey, timestamp);

  return [
    HR,
    `DATE: ${dateStr}`,
    HR,
    'DAILY CUMULATIVE TOTALS:',
    `Input Text:    ${fmt(summary.inputTextTokens)} tokens`,
    `Input Audio:   ${fmt(summary.inputAudioTokens)} tokens`,
    `Output Tokens: ${fmt(summary.outputTokens)} tokens`,
    `Estimated Cost: $${cost.toFixed(6)}`,
    '',
    '--- SESSIONS ---',
    sessionEntry,
    '',
  ].join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function appendSessionToLog(
  sessionId: string,
  summary: SessionCostSummary,
  sessionMinutes: number,
): Promise<void> {
  writeQueue = writeQueue.catch(() => undefined).then(async () => {
  const apiKey = process.env.GEMINI_LIVE_API_KEY ?? process.env.GEMINI_LLM_API_KEY ?? '(key not set)';
  const dateStr = localDateStr();
  const timestamp = localTimestampStr();

  // Read existing log file, or start fresh.
  let content = '';
  try {
    content = await fs.readFile(LOG_FILE, 'utf8');
  } catch {
    // File does not exist yet — will be created on write.
  }

  const dateSectionHeader = `DATE: ${dateStr}`;

  // ── New day: no block for today yet ──────────────────────────────────────
  if (!content.includes(dateSectionHeader)) {
    const newBlock = buildNewDayBlock(dateStr, sessionId, summary, sessionMinutes, apiKey, timestamp);
    // Ensure exactly one newline before the new block when appending to existing content.
    let prefix = '';
    if (content.length > 0) {
      prefix = content.endsWith('\n\n') ? '' : content.endsWith('\n') ? '\n' : '\n\n';
    }
    await fs.writeFile(LOG_FILE, content + prefix + newBlock, 'utf8');
    return;
  }

  // ── Existing day: update cumulative totals in-place, append session ───────

  const datePos = content.indexOf(dateSectionHeader);

  // Find the start of this day's block (the HR line immediately preceding DATE:).
  // Structure: ...\n================================================================================\nDATE: YYYY-MM-DD\n...
  const hrWithNewlines = '\n' + HR + '\n';
  const hrStartIdx = content.lastIndexOf(hrWithNewlines, datePos);
  const blockStart = hrStartIdx === -1
    ? 0                    // HR is at the very beginning of the file
    : hrStartIdx + 1;      // +1 to skip the leading '\n' (belongs to previous block's last line)

  // Find the end of this day's block: position of '\n' that begins the NEXT block's HR + DATE.
  // Pattern: "\n================================================================================\nDATE:"
  const nextBlockSignature = '\n' + HR + '\nDATE:';
  const nextBlockIdx = content.indexOf(nextBlockSignature, datePos + dateSectionHeader.length);
  const blockEnd = nextBlockIdx === -1 ? content.length : nextBlockIdx;

  const blockBefore = content.slice(0, blockStart);
  let blockContent = content.slice(blockStart, blockEnd);
  const blockAfter = content.slice(blockEnd);

  // Parse existing cumulative totals.
  const textMatch = blockContent.match(/^(Input Text:\s+)([\d,]+)( tokens)/m);
  const audioMatch = blockContent.match(/^(Input Audio:\s+)([\d,]+)( tokens)/m);
  const outputMatch = blockContent.match(/^(Output Tokens:\s+)([\d,]+)( tokens)/m);
  const costMatch = blockContent.match(/^(Estimated Cost:\s+\$)([\d.]+)/m);

  const prevInputText = textMatch ? parseInt(textMatch[2].replace(/,/g, ''), 10) : 0;
  const prevInputAudio = audioMatch ? parseInt(audioMatch[2].replace(/,/g, ''), 10) : 0;
  const prevOutput = outputMatch ? parseInt(outputMatch[2].replace(/,/g, ''), 10) : 0;
  const prevCost = costMatch ? parseFloat(costMatch[2]) : 0;

  const newInputText = prevInputText + summary.inputTextTokens;
  const newInputAudio = prevInputAudio + summary.inputAudioTokens;
  const newOutput = prevOutput + summary.outputTokens;
  const newCost = prevCost + (summary.estimatedCostUsd ?? 0);

  // Update cumulative totals in-place via regex (one replacement each, scoped to this block).
  blockContent = blockContent.replace(
    /^(Input Text:\s+)[\d,]+( tokens)/m,
    `$1${fmt(newInputText)}$2`,
  );
  blockContent = blockContent.replace(
    /^(Input Audio:\s+)[\d,]+( tokens)/m,
    `$1${fmt(newInputAudio)}$2`,
  );
  blockContent = blockContent.replace(
    /^(Output Tokens:\s+)[\d,]+( tokens)/m,
    `$1${fmt(newOutput)}$2`,
  );
  blockContent = blockContent.replace(
    /^(Estimated Cost:\s+\$)[\d.]+/m,
    `$1${newCost.toFixed(6)}`,
  );

  // Append new session entry (blank line separator, then entry, then trailing newline).
  const sessionEntry = buildSessionEntry(sessionId, summary, sessionMinutes, apiKey, timestamp);
  blockContent = blockContent.trimEnd() + '\n\n' + sessionEntry + '\n';

  await fs.writeFile(LOG_FILE, blockBefore + blockContent + blockAfter, 'utf8');
  });

  return writeQueue;
}
