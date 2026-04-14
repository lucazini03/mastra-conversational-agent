// src/services/contextManager/contextManager.ts
//
// Observational Memory & Context Compaction manager.
//
// This class tracks conversation transcript, monitors token usage, and
// asynchronously extracts a compact JSON state via a lightweight model.
// When it's time to switch WebSocket connections, it builds an injection
// payload that combines:  Base Prompt + Compact State + Unprocessed Buffer.
//
// Design goals:
//   1. Fully decoupled from the WebSocket handler — communicates via methods & EventEmitter.
//   2. Delta-only extraction: only sends transcript accumulated since the last extraction.
//   3. Volatile buffer: captures any transcript arriving between extraction start and WS switch.
//   4. Atomic switch: the switch fires at the first turnComplete AFTER extraction completes
//      (the natural silence moment when Gemini has finished speaking).

import { EventEmitter } from 'events';
import { generateObject } from 'ai';
import { google } from '@ai-sdk/google';
import type { AssistantId } from '../../config/professorConfig.js';
import { getSchemaForAssistant, type AnyAssistantState } from './schemas.js';

// ── Environment-driven configuration ────────────────────────────────────────

const MEMORY_EXTRACTION_TOKEN_THRESHOLD = parseInt(
  process.env.MEMORY_EXTRACTION_TOKEN_THRESHOLD ?? '50000',
  10,
);

const MEMORY_EXTRACTION_MODEL = process.env.MEMORY_EXTRACTION_MODEL ?? 'gemini-2.5-flash';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TranscriptEntry {
  role: 'user' | 'model';
  text: string;
  turnIndex: number;
}

export interface TokenUsageSnapshot {
  inputText: number;
  inputAudio: number;
}

export interface InjectionPayload {
  /** The full system instruction to inject into the new WebSocket setup. */
  systemInstruction: string;
  /** The compact JSON state (for logging / debugging). */
  compactState: AnyAssistantState;
  /** Raw unprocessed text that happened after extraction started. */
  unprocessedBuffer: string;
}

export interface ContextManagerEvents {
  /** Fired at the first turnComplete after a successful extraction. */
  switchReady: [payload: InjectionPayload];
  /** Fired when an extraction completes (success or failure). */
  extractionDone: [success: boolean, error?: string];
}

// ── ContextManager ───────────────────────────────────────────────────────────

export class ContextManager extends EventEmitter<ContextManagerEvents> {
  private sessionId: string;
  private assistantId: AssistantId;
  private baseSystemPrompt: string;

  // ── Transcript tracking ──────────────────────────────────────────────────
  private transcript: TranscriptEntry[] = [];
  private turnCounter = 0;

  // ── Extraction state ─────────────────────────────────────────────────────
  private lastExtractionTurnIndex = -1;
  private currentState: AnyAssistantState | null = null;
  private extractionInProgress = false;
  private extractionSucceeded = false;
  private extractionFlaggedForNextTurn = false;

  // ── Threshold delta tracking (Bug 2 fix) ─────────────────────────────────
  // Token count at the time of the last successful switch. The next extraction
  // triggers only when (currentTokens - lastSwitchTokenCount) >= threshold,
  // preventing infinite re-triggers after the first switch.
  private lastSwitchTokenCount = 0;

  // ── Volatile buffer ──────────────────────────────────────────────────────
  // Accumulates raw transcript text between the start of an extraction and
  // the actual WebSocket switch (i.e. the next turnComplete after extraction).
  private unprocessedBuffer: string[] = [];
  private bufferingSinceExtraction = false;

  constructor(opts: {
    sessionId: string;
    assistantId: AssistantId;
    baseSystemPrompt: string;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.assistantId = opts.assistantId;
    this.baseSystemPrompt = opts.baseSystemPrompt;
  }

  // ── Public API ───────────────────────────────────────────────────────────

  /** Record a new transcript entry. Call this for every user/model utterance. */
  addTranscriptEntry(role: 'user' | 'model', text: string): void {
    if (!text.trim()) return;

    this.turnCounter++;
    this.transcript.push({ role, text, turnIndex: this.turnCounter });

    // If we're in the extraction/buffering window, also capture raw text.
    if (this.bufferingSinceExtraction) {
      this.unprocessedBuffer.push(`[${role}]: ${text}`);
    }
  }

  /**
   * Called by the session handler when token usage is updated.
   * Checks whether the extraction threshold has been crossed and flags
   * the session for extraction on the next `turnComplete`.
   */
  checkTokenThreshold(usage: TokenUsageSnapshot): void {
    if (this.extractionInProgress || this.extractionFlaggedForNextTurn) return;
    if (this.extractionSucceeded) return; // already have a pending switch

    const totalInput = usage.inputText + usage.inputAudio;
    const delta = totalInput - this.lastSwitchTokenCount;
    if (delta >= MEMORY_EXTRACTION_TOKEN_THRESHOLD) {
      this.extractionFlaggedForNextTurn = true;
      console.log(
        `[${this.sessionId}] ContextManager: token delta threshold reached (delta=${delta}, total=${totalInput}, lastSwitch=${this.lastSwitchTokenCount}, threshold=${MEMORY_EXTRACTION_TOKEN_THRESHOLD}). Will extract on next turnComplete.`,
      );
    }
  }

  /**
   * Called when a Gemini turn completes (`serverContent.turnComplete`).
   *
   * Two paths:
   *   A. Extraction already finished → this is the natural silence moment
   *      right after Gemini stopped speaking. Emit `switchReady` NOW.
   *   B. Extraction flagged but not started → kick off the async extraction.
   *      The volatile buffer will capture anything that happens while it runs.
   *      When the extraction finishes, the NEXT turnComplete will hit path A.
   */
  onTurnComplete(): void {
    // ── Path A: extraction done → switch at this silence moment ──────────
    if (this.extractionSucceeded && !this.extractionInProgress) {
      this.emitSwitchReady();
      return;
    }

    // ── Path B: extraction flagged, kick it off ──────────────────────────
    if (this.extractionFlaggedForNextTurn && !this.extractionInProgress) {
      this.extractionFlaggedForNextTurn = false;
      this.runExtraction();
    }
  }

  /**
   * Force-build the injection payload right now (e.g. for an immediate
   * reconnect that wants to include whatever state we have).
   * Returns null if no state has been extracted yet.
   */
  buildInjectionPayload(): InjectionPayload | null {
    if (!this.currentState) return null;

    // Ensure the buffer tail is a model message so the new session
    // doesn't interpret the last user message as a pending request.
    this.ensureBufferEndsWithModel();

    const bufferText = this.unprocessedBuffer.join('\n').trim();
    const systemInstruction = this.assembleSystemInstruction(this.currentState, bufferText);

    return {
      systemInstruction,
      compactState: this.currentState,
      unprocessedBuffer: bufferText,
    };
  }

  /** Reset state after a successful WebSocket switch. */
  onWebSocketSwitched(currentTokenCount: number): void {
    this.lastSwitchTokenCount = currentTokenCount;
    this.extractionSucceeded = false;
    this.extractionFlaggedForNextTurn = false;
    this.bufferingSinceExtraction = false;
    this.unprocessedBuffer = [];
    // Keep transcript and currentState — they persist across switches.
    console.log(
      `[${this.sessionId}] ContextManager: switch complete. lastSwitchTokenCount updated to ${currentTokenCount}.`,
    );
  }

  /** Whether the manager has a compact state ready for injection. */
  get hasCompactState(): boolean {
    return this.currentState !== null;
  }

  /** Whether an extraction is currently running in the background. */
  get isExtracting(): boolean {
    return this.extractionInProgress;
  }

  /** Whether a switch is pending (extraction done, waiting for next turnComplete). */
  get isSwitchPending(): boolean {
    return this.extractionSucceeded && !this.extractionInProgress;
  }

  // ── Extraction ───────────────────────────────────────────────────────────

  private async runExtraction(): Promise<void> {
    if (this.extractionInProgress) return;
    this.extractionInProgress = true;
    this.bufferingSinceExtraction = true;
    this.unprocessedBuffer = [];

    const deltaEntries = this.transcript.filter(
      (e) => e.turnIndex > this.lastExtractionTurnIndex,
    );

    if (deltaEntries.length === 0) {
      console.log(`[${this.sessionId}] ContextManager: no new transcript to extract. Skipping.`);
      this.extractionInProgress = false;
      this.bufferingSinceExtraction = false;
      return;
    }

    const deltaText = deltaEntries
      .map((e) => `[${e.role}]: ${e.text}`)
      .join('\n');

    const lastTurnIndex = deltaEntries[deltaEntries.length - 1].turnIndex;
    const schema = getSchemaForAssistant(this.assistantId);

    const existingStateJSON = this.currentState
      ? JSON.stringify(this.currentState, null, 2)
      : 'null (first extraction — create the state from scratch)';

    const extractionPrompt = `You are maintaining a rolling JSON state for a voice conversation.

CURRENT STATE:
${existingStateJSON}

NEW TRANSCRIPT DELTA (turns since last extraction):
${deltaText}

INSTRUCTIONS:
- MERGE the new information from the transcript delta INTO the existing state.
- UPDATE fields where new information supersedes old information.
- APPEND to array fields (topics_covered, weak_areas, etc.) — do NOT overwrite them.
- If the existing state is null, create it from scratch based on the delta.
- Always preserve and update behavioral_directives with any new observations about user preferences, tone, or requests.
- Be concise: use short phrases, not full sentences.
- Only include information that is explicitly present in the conversation.`;

    try {
      console.log(
        `[${this.sessionId}] ContextManager: extracting state from ${deltaEntries.length} turns (turns ${this.lastExtractionTurnIndex + 1}..${lastTurnIndex})...`,
      );

      const { object } = await generateObject({
        model: google(MEMORY_EXTRACTION_MODEL),
        schema,
        prompt: extractionPrompt,
      });

      this.currentState = object as AnyAssistantState;
      this.lastExtractionTurnIndex = lastTurnIndex;
      this.extractionSucceeded = true;

      console.log(
        `[${this.sessionId}] ContextManager: extraction succeeded. Extracted state:`,
      );
      console.log(JSON.stringify(this.currentState, null, 2));

      this.emit('extractionDone', true);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[${this.sessionId}] ContextManager: extraction failed:`, message);

      // Don't block future extractions — allow retry on next threshold cross.
      this.extractionFlaggedForNextTurn = false;
      this.emit('extractionDone', false, message);
    } finally {
      this.extractionInProgress = false;
    }
  }

  // ── Injection assembly ───────────────────────────────────────────────────

  /**
   * Ensures the buffer ends with a model message so Gemini sees a completed
   * turn and waits for new user input instead of regenerating a response.
   * If the last entry is a user message, we append a placeholder.
   */
  private ensureBufferEndsWithModel(): void {
    if (this.unprocessedBuffer.length === 0) return;

    const last = this.unprocessedBuffer[this.unprocessedBuffer.length - 1];
    // Buffer entries are formatted as "[role]: text"
    if (last.startsWith('[user]')) {
      // The model hasn't responded yet — the switch fires at turnComplete,
      // so normally this shouldn't happen. But as a safety net, append a
      // synthetic marker so the new session doesn't re-answer the last query.
      this.unprocessedBuffer.push('[model]: (risposta in corso, interrotta dallo switch di sessione)');
    }
  }

  private assembleSystemInstruction(
    state: AnyAssistantState,
    bufferText: string,
  ): string {
    const sections: string[] = [];

    // 1. Base system prompt (persona instructions)
    sections.push(this.baseSystemPrompt);

    // 2. Compact memory (JSON state)
    sections.push(
      `\n---\n## CONVERSATION MEMORY (Compact State)\nThe following JSON represents the accumulated state of this conversation so far. Use it to maintain continuity — do NOT ask the user to repeat information already captured here.\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``,
    );

    // 3. Unprocessed buffer (recent context bridge)
    if (bufferText) {
      sections.push(
        `\n---\n## RECENT CONTEXT (Already Delivered)\nThe following exchanges already happened — the user has already received these responses. This is provided ONLY for your context. Do NOT repeat, paraphrase, or re-deliver any of these responses. Simply continue the conversation from where it left off, waiting for the user's next input.\n\n${bufferText}`,
      );
    }

    return sections.join('\n');
  }

  // ── Switch emission ──────────────────────────────────────────────────────

  private emitSwitchReady(): void {
    const payload = this.buildInjectionPayload();
    if (!payload) return;

    console.log(
      `[${this.sessionId}] ContextManager: emitting switchReady at turnComplete. Buffer lines: ${this.unprocessedBuffer.length}`,
    );

    this.emit('switchReady', payload);
  }
}
