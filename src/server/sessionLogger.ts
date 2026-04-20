// src/server/sessionLogger.ts
//
// Per-session file logger that records the full lifecycle of each WebSocket
// connection ("episode") to Gemini Live:
//   • Transcript  (user + model turns, deduplicated)
//   • Token usage delta (per-episode, broken down by modality)
//   • RAG tool calls (query, sources, estimated tokens)
//   • Compact JSON memory state generated during the episode
//   • Timing (absolute timestamps + session-relative minutes)
//
// Written at session teardown to  logs/sessions/  (excluded from git).
// Two files per session:
//   YYYY-MM-DD_HH-MM-SS_<sessionId8>.log   — human-readable report
//   YYYY-MM-DD_HH-MM-SS_<sessionId8>.json  — machine-readable JSON

import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { AnyAssistantState } from '../services/contextManager/schemas.js';
import type { SessionCostSummary } from './sessionCostTracker.js';

const LOG_DIR = path.join(process.cwd(), 'logs', 'sessions');

// ── Public types ──────────────────────────────────────────────────────────────

export type EpisodeTrigger = 'initial_connection' | 'reconnect' | 'context_switch';

export interface FullTokenSnapshot {
  inputText: number;
  inputAudio: number;
  outputText: number;
  outputAudio: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface TranscriptLine {
  role: 'user' | 'model';
  text: string;
}

interface RagCallRecord {
  query: string;
  sources: string[];
  estimatedTokens: number;
}

interface TokenDelta {
  inputText: number;
  inputAudio: number;
  outputText: number;
  outputAudio: number;
  totalInput: number;
  totalOutput: number;
}

interface Episode {
  index: number;
  trigger: EpisodeTrigger;
  startedAtMs: number;
  endedAtMs: number | null;
  startTokens: FullTokenSnapshot;
  endTokens: FullTokenSnapshot | null;
  transcript: TranscriptLine[];
  ragCalls: RagCallRecord[];
  /** Compact JSON memory state generated (and logged) during this episode — just before the context switch fires. */
  compactStateGenerated: AnyAssistantState | null;
  extractionModel: string | null;
}

// ── SessionLogger ─────────────────────────────────────────────────────────────

export class SessionLogger {
  private readonly sessionId: string;
  private readonly assistantId: string;
  private readonly sessionStartedAtMs: number;

  private episodes: Episode[] = [];
  private current: Episode | null = null;
  private episodeCounter = 0;
  /** Prevents writing the log file more than once. */
  private finalized = false;

  constructor(sessionId: string, assistantId: string) {
    this.sessionId = sessionId;
    this.assistantId = assistantId;
    this.sessionStartedAtMs = Date.now();
  }

  // ── Episode lifecycle ─────────────────────────────────────────────────────

  /**
   * Opens a new WebSocket episode.
   * Automatically closes the current episode first, using `tokenSnapshot` as
   * its final token counts (same snapshot becomes the starting point of the
   * new episode, so there is no token "gap" between episodes).
   */
  startEpisode(trigger: EpisodeTrigger, tokenSnapshot: FullTokenSnapshot): void {
    if (this.current && this.current.endedAtMs === null) {
      this.current.endedAtMs = Date.now();
      this.current.endTokens = { ...tokenSnapshot };
    }

    this.episodeCounter++;
    const episode: Episode = {
      index: this.episodeCounter,
      trigger,
      startedAtMs: Date.now(),
      endedAtMs: null,
      startTokens: { ...tokenSnapshot },
      endTokens: null,
      transcript: [],
      ragCalls: [],
      compactStateGenerated: null,
      extractionModel: null,
    };
    this.episodes.push(episode);
    this.current = episode;
  }

  /**
   * Closes the current episode without opening a new one.
   * Called at session teardown before `finalizeSession`.
   */
  closeCurrentEpisode(tokenSnapshot: FullTokenSnapshot): void {
    if (!this.current || this.current.endedAtMs !== null) return;
    this.current.endedAtMs = Date.now();
    this.current.endTokens = { ...tokenSnapshot };
  }

  // ── Data accumulation ─────────────────────────────────────────────────────

  /**
   * Appends a transcript line to the current episode.
   * Adjacent-duplicate suppression: skips if the last recorded line has the
   * same role + text (handles the overlap between 'writing' events and
   * automatic audio transcription mirrors).
   */
  addTranscriptLine(role: 'user' | 'model', text: string): void {
    if (!this.current || !text.trim()) return;
    const t = this.current.transcript;
    if (t.length > 0) {
      const last = t[t.length - 1];
      if (last.role === role && last.text === text.trim()) return;
    }
    t.push({ role, text: text.trim() });
  }

  /** Records a RAG tool invocation against the current episode. */
  recordRagCall(query: string, sources: string[], estimatedTokens: number): void {
    this.current?.ragCalls.push({ query, sources, estimatedTokens });
  }

  /**
   * Records the compact JSON memory state extracted during the current episode.
   * Should be called just before the context switch fires (so the state is
   * attributed to the episode that produced it, not the one that consumes it).
   */
  recordCompactState(state: AnyAssistantState, model: string | null): void {
    if (!this.current) return;
    this.current.compactStateGenerated = state;
    this.current.extractionModel = model;
  }

  // ── Finalization ──────────────────────────────────────────────────────────

  /**
   * Writes `.log` and `.json` files to `logs/sessions/`.
   * Safe to call multiple times — subsequent calls are no-ops.
   */
  async finalizeSession(costSummary?: SessionCostSummary): Promise<void> {
    if (this.finalized) return;
    this.finalized = true;

    try {
      await fs.mkdir(LOG_DIR, { recursive: true });

      const now = new Date();
      const dateStr = now.toISOString().replace(/:/g, '-').replace('T', '_').slice(0, 19);
      const safeId = this.sessionId.slice(0, 8).replace(/[^a-zA-Z0-9_-]/g, '_');
      const base = path.join(LOG_DIR, `${dateStr}_${safeId}`);

      await Promise.all([
        fs.writeFile(`${base}.log`, this.buildHumanLog(costSummary), 'utf8'),
        fs.writeFile(`${base}.json`, JSON.stringify(this.buildJsonReport(costSummary), null, 2), 'utf8'),
      ]);

      console.log(`[${this.sessionId}] Session log written → ${base}.log`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] Failed to write session log: ${msg}`);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private minutesSinceStart(ms: number): string {
    return ((ms - this.sessionStartedAtMs) / 60_000).toFixed(2);
  }

  private durationMin(startMs: number, endMs: number): string {
    return ((endMs - startMs) / 60_000).toFixed(2);
  }

  private toIso(ms: number): string {
    return new Date(ms).toISOString();
  }

  private computeDelta(start: FullTokenSnapshot, end: FullTokenSnapshot): TokenDelta {
    const inputText = Math.max(0, end.inputText - start.inputText);
    const inputAudio = Math.max(0, end.inputAudio - start.inputAudio);
    const outputText = Math.max(0, end.outputText - start.outputText);
    const outputAudio = Math.max(0, end.outputAudio - start.outputAudio);
    return {
      inputText,
      inputAudio,
      outputText,
      outputAudio,
      totalInput: inputText + inputAudio,
      totalOutput: outputText + outputAudio,
    };
  }

  // ── Human-readable .log ───────────────────────────────────────────────────

  private buildHumanLog(costSummary?: SessionCostSummary): string {
    const W = 82;
    const HR = '═'.repeat(W);
    const hr = '─'.repeat(W);
    const lines: string[] = [];

    const sessionEndMs = Date.now();
    const totalDur = this.durationMin(this.sessionStartedAtMs, sessionEndMs);

    lines.push(HR);
    lines.push('  SESSION LOG');
    lines.push(HR);
    lines.push(`  Session ID   : ${this.sessionId}`);
    lines.push(`  Assistant    : ${this.assistantId}`);
    lines.push(`  Started at   : ${this.toIso(this.sessionStartedAtMs)}`);
    lines.push(`  Ended at     : ${this.toIso(sessionEndMs)}`);
    lines.push(`  Duration     : ${totalDur} min`);
    lines.push(`  WS episodes  : ${this.episodes.length}`);

    // ── Session-wide token totals ─────────────────────────────────────────
    if (costSummary) {
      lines.push('');
      lines.push('  SESSION TOKEN TOTALS');
      lines.push('  ' + hr.slice(2));
      const fmt = (n: number) => n.toLocaleString('en-US').padStart(12);
      lines.push(`  Input  text  : ${fmt(costSummary.inputTextTokens)}`);
      lines.push(`  Input  audio : ${fmt(costSummary.inputAudioTokens)}`);
      lines.push(`  Output text  : ${fmt(costSummary.outputTextTokens)}`);
      lines.push(`  Output audio : ${fmt(costSummary.outputAudioTokens)}`);
      lines.push(`  ${'─'.repeat(30)}`);
      lines.push(`  Total  input : ${fmt(costSummary.inputTokens)}`);
      lines.push(`  Total  output: ${fmt(costSummary.outputTokens)}`);
      const ragLabel = `${costSummary.ragCalls} call${costSummary.ragCalls !== 1 ? 's' : ''}`;
      lines.push(`  RAG est. tok : ${fmt(costSummary.ragTokens)}  (${ragLabel})`);
      if (costSummary.estimatedCostUsd !== null) {
        lines.push(`  Est. cost USD: $${costSummary.estimatedCostUsd.toFixed(6)}`);
      } else {
        lines.push(`  Est. cost USD: (pricing env vars not set)`);
      }

      // Doc summary generation cost (only non-zero when cache was cold)
      lines.push('');
      lines.push('  DOC SUMMARY GENERATION (LLM, cached after first run)');
      lines.push('  ' + hr.slice(2));
      lines.push(`  Input  tokens: ${fmt(costSummary.summaryInputTokens)}`);
      lines.push(`  Output tokens: ${fmt(costSummary.summaryOutputTokens)}`);
      if (costSummary.summaryCostUsd !== null) {
        lines.push(`  Est. cost USD: $${costSummary.summaryCostUsd.toFixed(6)}`);
      } else {
        lines.push(`  Est. cost USD: (pricing env vars not set)`);
      }

      // Context-switch extraction costs
      lines.push('');
      lines.push(`  CONTEXT-SWITCH EXTRACTIONS (${costSummary.extractionCount} run${costSummary.extractionCount !== 1 ? 's' : ''})`);
      lines.push('  ' + hr.slice(2));
      lines.push(`  Input  tokens: ${fmt(costSummary.extractionInputTokens)}`);
      lines.push(`  Output tokens: ${fmt(costSummary.extractionOutputTokens)}`);
      if (costSummary.extractionCostUsd !== null) {
        lines.push(`  Est. cost USD: $${costSummary.extractionCostUsd.toFixed(6)}`);
      } else {
        lines.push(`  Est. cost USD: (pricing env vars not set)`);
      }
    }

    // ── Per-episode sections ──────────────────────────────────────────────
    for (const ep of this.episodes) {
      lines.push('');
      lines.push(HR);

      const triggerLabel: Record<EpisodeTrigger, string> = {
        initial_connection: 'INITIAL CONNECTION',
        reconnect: 'RECONNECT (Google dropped the line)',
        context_switch: 'CONTEXT SWITCH (memory compaction → new WS)',
      };
      lines.push(`  WebSocket #${ep.index}  —  ${triggerLabel[ep.trigger]}`);
      lines.push(HR);

      const startMin = this.minutesSinceStart(ep.startedAtMs);
      const endMin = ep.endedAtMs ? this.minutesSinceStart(ep.endedAtMs) : 'ongoing';
      const dur = ep.endedAtMs ? this.durationMin(ep.startedAtMs, ep.endedAtMs) : '—';

      lines.push(`  Start        : ${this.toIso(ep.startedAtMs)}  (session min ${startMin})`);
      if (ep.endedAtMs) {
        lines.push(`  End          : ${this.toIso(ep.endedAtMs)}  (session min ${endMin})`);
      }
      lines.push(`  Duration     : ${dur} min`);

      // Token delta
      lines.push('');
      lines.push('  Tokens in this WebSocket connection:');
      if (ep.endTokens) {
        const d = this.computeDelta(ep.startTokens, ep.endTokens);
        const fmt = (n: number) => n.toLocaleString('en-US').padStart(10);
        lines.push(`    Input  text  : ${fmt(d.inputText)}`);
        lines.push(`    Input  audio : ${fmt(d.inputAudio)}`);
        lines.push(`    Output text  : ${fmt(d.outputText)}`);
        lines.push(`    Output audio : ${fmt(d.outputAudio)}`);
        lines.push(`    ${'─'.repeat(26)}`);
        lines.push(`    Total  input : ${fmt(d.totalInput)}`);
        lines.push(`    Total  output: ${fmt(d.totalOutput)}`);
      } else {
        lines.push('    (episode still open — final snapshot not yet captured)');
      }

      // RAG calls
      lines.push('');
      if (ep.ragCalls.length === 0) {
        lines.push('  RAG calls    : none');
      } else {
        const totalRagTok = ep.ragCalls.reduce((s, r) => s + r.estimatedTokens, 0);
        lines.push(`  RAG calls (${ep.ragCalls.length}  •  ~${totalRagTok.toLocaleString()} est. tokens total):`);
        for (let i = 0; i < ep.ragCalls.length; i++) {
          const r = ep.ragCalls[i];
          lines.push(`    [${i + 1}]  query   : "${r.query}"`);
          lines.push(`         sources : ${r.sources.length > 0 ? r.sources.join(', ') : 'none'}`);
          lines.push(`         est.tok : ${r.estimatedTokens.toLocaleString()}`);
        }
      }

      // Memory extraction
      lines.push('');
      if (ep.compactStateGenerated) {
        lines.push(`  Memory extraction (model: ${ep.extractionModel ?? 'unknown'}):`);
        const stateJson = JSON.stringify(ep.compactStateGenerated, null, 2)
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n');
        lines.push(stateJson);
      } else {
        lines.push('  Memory extraction: not triggered in this episode');
      }

      // Transcript
      lines.push('');
      const turnCount = ep.transcript.length;
      lines.push(`  Transcript (${turnCount} turn${turnCount !== 1 ? 's' : ''}):`);
      if (turnCount === 0) {
        lines.push('    (no transcript captured)');
      } else {
        for (const t of ep.transcript) {
          const label = t.role === 'user' ? '[ USER  ]' : '[ MODEL ]';
          const prefix = `    ${label}  `;
          const indent = ' '.repeat(prefix.length);
          const maxLineWidth = W - indent.length;

          // Word-wrap long lines
          const words = t.text.split(' ');
          let current = prefix;
          for (const word of words) {
            if (current !== prefix && current.length - indent.length + 1 + word.length > maxLineWidth) {
              lines.push(current);
              current = indent + word;
            } else {
              current += (current === prefix ? '' : ' ') + word;
            }
          }
          if (current.trim()) lines.push(current);
        }
      }
    }

    lines.push('');
    lines.push(HR);
    lines.push('  END OF SESSION LOG');
    lines.push(HR);
    return lines.join('\n') + '\n';
  }

  // ── Machine-readable .json ────────────────────────────────────────────────

  private buildJsonReport(costSummary?: SessionCostSummary) {
    const sessionEndMs = Date.now();

    return {
      sessionId: this.sessionId,
      assistantId: this.assistantId,
      sessionStartedAt: this.toIso(this.sessionStartedAtMs),
      sessionEndedAt: this.toIso(sessionEndMs),
      sessionDurationMinutes: parseFloat(this.durationMin(this.sessionStartedAtMs, sessionEndMs)),
      totalEpisodes: this.episodes.length,
      tokenSessionTotals: costSummary
        ? {
            inputText: costSummary.inputTextTokens,
            inputAudio: costSummary.inputAudioTokens,
            outputText: costSummary.outputTextTokens,
            outputAudio: costSummary.outputAudioTokens,
            totalInput: costSummary.inputTokens,
            totalOutput: costSummary.outputTokens,
            ragEstimated: costSummary.ragTokens,
            ragCalls: costSummary.ragCalls,
            estimatedCostUsd: costSummary.estimatedCostUsd,
            docSummaryGeneration: {
              inputTokens: costSummary.summaryInputTokens,
              outputTokens: costSummary.summaryOutputTokens,
              estimatedCostUsd: costSummary.summaryCostUsd,
            },
            contextSwitchExtractions: {
              count: costSummary.extractionCount,
              inputTokens: costSummary.extractionInputTokens,
              outputTokens: costSummary.extractionOutputTokens,
              estimatedCostUsd: costSummary.extractionCostUsd,
            },
          }
        : null,
      episodes: this.episodes.map((ep) => ({
        index: ep.index,
        trigger: ep.trigger,
        startedAt: this.toIso(ep.startedAtMs),
        endedAt: ep.endedAtMs ? this.toIso(ep.endedAtMs) : null,
        sessionMinuteStart: parseFloat(this.minutesSinceStart(ep.startedAtMs)),
        sessionMinuteEnd: ep.endedAtMs
          ? parseFloat(this.minutesSinceStart(ep.endedAtMs))
          : null,
        durationMinutes: ep.endedAtMs
          ? parseFloat(this.durationMin(ep.startedAtMs, ep.endedAtMs))
          : null,
        tokensDelta: ep.endTokens ? this.computeDelta(ep.startTokens, ep.endTokens) : null,
        ragCalls: ep.ragCalls,
        compactStateGenerated: ep.compactStateGenerated,
        extractionModel: ep.extractionModel,
        transcript: ep.transcript,
      })),
    };
  }
}
