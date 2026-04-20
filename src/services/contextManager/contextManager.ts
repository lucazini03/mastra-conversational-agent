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
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { AssistantId } from '../../config/professorConfig.js';
import { getSchemaForAssistant, type AnyAssistantState, type SessionMode } from './schemas.js';

// ── Environment-driven configuration ────────────────────────────────────────

const MEMORY_EXTRACTION_TOKEN_THRESHOLD = parseInt(
  process.env.MEMORY_EXTRACTION_TOKEN_THRESHOLD ?? '50000',
  10,
);

const MEMORY_EXTRACTION_MODEL = process.env.MEMORY_EXTRACTION_MODEL ?? 'gemini-3.1-flash-lite-preview';
const MEMORY_EXTRACTION_MODEL_BACKUP =
  process.env.MEMORY_EXTRACTION_MODEL_BACKUP ?? 'gemini-2.5-flash-lite';

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
  /** The model name that successfully produced the extraction (null if unknown). */
  extractionModel: string | null;
  /** Buffer turns merged into coherent user/model turns — used to craft realtime_input continuation hint. */
  structuredBufferTurns: Array<{ role: 'user' | 'model'; text: string }>;
}

export interface ContextManagerEvents {
  /** Fired at the first turnComplete after a successful extraction. */
  switchReady: [payload: InjectionPayload];
  /** Fired when an extraction completes (success or failure). */
  extractionDone: [success: boolean, error?: string];
  /** Fired after a successful extraction with the token counts for that call. */
  extractionUsage: [inputTokens: number, outputTokens: number];
}

// ── ContextManager ───────────────────────────────────────────────────────────

export class ContextManager extends EventEmitter<ContextManagerEvents> {
  private sessionId: string;
  private assistantId: AssistantId;
  private baseSystemPrompt: string;
  /** Professor-only: RAG (document-based) or FREE_ROAM (knowledge-based). */
  private sessionMode: SessionMode | undefined;

  // ── Transcript tracking ──────────────────────────────────────────────────
  private transcript: TranscriptEntry[] = [];
  private turnCounter = 0;

  // ── Extraction state ─────────────────────────────────────────────────────
  private lastExtractionTurnIndex = -1;
  private currentState: AnyAssistantState | null = null;
  private extractionInProgress = false;
  private extractionSucceeded = false;
  private extractionFlaggedForNextTurn = false;
  private lastSuccessfulExtractionModel: string | null = null;

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
  // Structured version of the buffer: consecutive same-role fragments merged
  // into whole turns, ready for clientContent seeding on the new WebSocket.
  private structuredBufferTurns: Array<{ role: 'user' | 'model'; text: string }> = [];

  constructor(opts: {
    sessionId: string;
    assistantId: AssistantId;
    baseSystemPrompt: string;
    /** Professor-only: determines extraction strategy and markdown format. */
    sessionMode?: SessionMode;
  }) {
    super();
    this.sessionId = opts.sessionId;
    this.assistantId = opts.assistantId;
    this.baseSystemPrompt = opts.baseSystemPrompt;
    this.sessionMode = opts.sessionMode;
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

      // Merge consecutive same-role fragments into a single coherent turn.
      const last = this.structuredBufferTurns[this.structuredBufferTurns.length - 1];
      if (last && last.role === role) {
        last.text += ' ' + text;
      } else {
        this.structuredBufferTurns.push({ role, text });
      }
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

    const bufferText = this.unprocessedBuffer.join('\n').trim();
    const systemInstruction = this.assembleSystemInstruction(this.currentState, bufferText);

    return {
      systemInstruction,
      compactState: this.currentState,
      unprocessedBuffer: bufferText,
      extractionModel: this.lastSuccessfulExtractionModel,
      structuredBufferTurns: [...this.structuredBufferTurns],
    };
  }

  /** Reset state after a successful WebSocket switch. */
  onWebSocketSwitched(currentTokenCount: number): void {
    this.lastSwitchTokenCount = currentTokenCount;
    this.extractionSucceeded = false;
    this.extractionFlaggedForNextTurn = false;
    this.bufferingSinceExtraction = false;
    this.unprocessedBuffer = [];
    this.structuredBufferTurns = [];
    // Keep transcript and currentState — they persist across switches.
    console.log(
      `[${this.sessionId}] ContextManager: switch complete. lastSwitchTokenCount updated to ${currentTokenCount}.`,
    );
  }

  /**
   * Pre-populate the state from an externally computed initial value (e.g. a
   * topics_to_cover list built from the document summary at session start).
   * This ensures the first extraction merges INTO the pre-populated state
   * rather than creating it from scratch.
   */
  setInitialState(state: AnyAssistantState): void {
    this.currentState = state;
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
    this.structuredBufferTurns = [];

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

    // ── Build the extraction prompt based on assistant type and session mode ──
    const extractionPrompt = this.buildExtractionPrompt(existingStateJSON, deltaText);

    const modelCandidates = [MEMORY_EXTRACTION_MODEL, MEMORY_EXTRACTION_MODEL_BACKUP].filter(
      (value, index, all) => value.trim().length > 0 && all.indexOf(value) === index,
    );

    let extractedObject: AnyAssistantState | null = null;
    let lastError: unknown = null;

    for (const modelName of modelCandidates) {
      try {
        console.log(
          `[${this.sessionId}] ContextManager: extracting state from ${deltaEntries.length} turns (turns ${this.lastExtractionTurnIndex + 1}..${lastTurnIndex}) using ${modelName}...`,
        );

        const { object, usage } = await generateObject({
          model: createGoogleGenerativeAI({ apiKey: process.env.GEMINI_LLM_API_KEY ?? '' })(modelName),
          schema,
          prompt: extractionPrompt,
        });

        extractedObject = object as AnyAssistantState;
        this.lastSuccessfulExtractionModel = modelName;
        this.emit('extractionUsage', usage.inputTokens ?? 0, usage.outputTokens ?? 0);
        console.log(`[${this.sessionId}] ContextManager: extraction succeeded with ${modelName}.`);
        break;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        console.warn(`[${this.sessionId}] ContextManager: extraction failed with ${modelName}: ${message}`);
      }
    }

    if (!extractedObject) {
      const message = lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown extraction error');
      console.error(`[${this.sessionId}] ContextManager: extraction failed with all models: ${message}`);

      // Don't block future extractions — allow retry on next threshold cross.
      this.extractionFlaggedForNextTurn = false;
      this.emit('extractionDone', false, message);
      this.extractionInProgress = false;
      return;
    }

    this.currentState = extractedObject;
    this.lastExtractionTurnIndex = lastTurnIndex;
    this.extractionSucceeded = true;

    // ── Debug logging: JSON state + markdown summary (if professor) ───────
    console.log(
      `[${this.sessionId}] ContextManager: extraction succeeded [mode=${this.sessionMode ?? 'generic'}]. Extracted JSON state:`,
    );
    console.log(JSON.stringify(this.currentState, null, 2));

    if (this.assistantId === 'professor' && this.sessionMode) {
      const markdown = generateMarkdownSummary(this.currentState, this.sessionMode);
      console.log(`[${this.sessionId}] ContextManager: corresponding Markdown summary:`);
      console.log(markdown);
    }

    this.emit('extractionDone', true);
    this.extractionInProgress = false;
  }

  // ── Injection assembly ───────────────────────────────────────────────────

  /**
   * The switch should only fire once the buffer ends on a completed assistant
   * turn. That prevents the new session from interpreting a dangling user
   * request as a fresh prompt and repeating the last answer.
   */
  private hasCompletedAssistantTail(): boolean {
    if (this.unprocessedBuffer.length === 0) return true;

    const last = this.unprocessedBuffer[this.unprocessedBuffer.length - 1];
    return last.startsWith('[model]');
  }

  private assembleSystemInstruction(
    state: AnyAssistantState,
    bufferText: string,
  ): string {
    const sections: string[] = [];

    // 1. Base system prompt (persona instructions)
    sections.push(this.baseSystemPrompt);

    // 2. Session-continuation override — placed immediately after the base prompt
    //    so that any "open with Phase 1 / introduce yourself" imperatives in the
    //    base prompt are overridden BEFORE the model acts on them.
    sections.push(
      `\n---\n## ⚠️ SESSION CONTINUATION — READ BEFORE ACTING\n\n` +
      `You are RESUMING an ONGOING conversation that is already in progress. This is NOT a new session.\n\n` +
      `MANDATORY OVERRIDES (these take priority over any phase/flow instructions above):\n` +
      `1. Do NOT re-introduce yourself or greet the user as if meeting for the first time.\n` +
      `2. Do NOT re-execute any opening, onboarding, or introductory phase described in your instructions above.\n` +
      `3. Do NOT call any search or document tool (e.g. search_documents) to retrieve information already present in the Session State below — it was already retrieved earlier in this session.\n` +
      `4. Consult the SESSION STATE below to understand where you are in the conversation and continue seamlessly from that point.\n` +
      `5. Your next action must be a DIRECT CONTINUATION — respond to the user's last message or wait quietly for their input.`,
    );

    // 3. Session state — markdown for professor (compact), JSON for others
    if (this.assistantId === 'professor' && this.sessionMode) {
      const markdown = generateMarkdownSummary(state, this.sessionMode);
      sections.push(`\n---\n${markdown}`);
    } else {
      sections.push(
        `\n---\n## SESSION STATE (Compact State)\nThe following JSON represents the accumulated state of this conversation so far. Use it to maintain continuity — do NOT ask the user to repeat information already captured here.\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``,
      );
    }

    // 4. Recent conversation transcript (structured turns + anti-repetition)
    if (this.structuredBufferTurns.length > 0) {
      const turnLines = this.structuredBufferTurns.map((t, i) => {
        const label = t.role === 'model' ? 'YOU (assistant)' : 'USER';
        return `TURN ${i + 1} — ${label}: "${t.text}"`;
      });

      const lastModelTurn = [...this.structuredBufferTurns]
        .reverse()
        .find((t) => t.role === 'model');

      let lastMessageBlock = '';
      if (lastModelTurn) {
        lastMessageBlock =
          `\n════════════════════════════════════════\n` +
          `YOUR LAST MESSAGE (already delivered):\n` +
          `"${lastModelTurn.text}"\n` +
          `════════════════════════════════════════\n`;
      }

      sections.push(
        `\n---\n## CONVERSATION TRANSCRIPT (Already Spoken — DO NOT REPEAT)\n\n` +
        `The following exchange ALREADY happened. Both you and the user heard it.\n` +
        `This is HISTORY, not new content.\n\n` +
        turnLines.join('\n') +
        lastMessageBlock +
        `\nMANDATORY RULES:\n` +
        `1. You have ALREADY said everything above. NEVER repeat, rephrase, or restate any of it.\n` +
        `2. The user is currently responding or about to respond to your last message. LISTEN and react to their words.\n` +
        `3. Your next response must be a DIRECT CONTINUATION — acknowledge what the user says and move forward naturally.`,
      );
    } else if (bufferText) {
      // Fallback: raw buffer text (no structured turns available)
      sections.push(
        `\n---\n## RECENT CONTEXT (Already Delivered — DO NOT REPEAT)\n` +
        `The exchanges below already took place. The user has already heard every response listed here.\n\n` +
        `CRITICAL RULES:\n` +
        `• Do NOT re-ask, rephrase, paraphrase, or re-deliver ANY question or statement that appears below.\n` +
        `• When the user's next audio arrives, respond DIRECTLY and NATURALLY as a seamless continuation.\n\n` +
        `${bufferText}`,
      );
    }

    return sections.join('\n');
  }
  // ── Extraction prompt builders ─────────────────────────────────────────

  /**
   * Builds the extraction prompt based on assistant type and session mode.
   * Professor gets mode-specific prompts; all other assistants use the generic one.
   */
  private buildExtractionPrompt(existingStateJSON: string, deltaText: string): string {
    const header = `You are a memory extraction engine for a voice conversation. You receive the current JSON state and a new transcript delta. You must output the updated state.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT STATE:
${existingStateJSON}

NEW TRANSCRIPT DELTA (roles: [model] = assistant/professor, [user] = student/visitor):
${deltaText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

    // ── Professor RAG: update mastery scores on fixed syllabus ────────────
    if (this.assistantId === 'professor' && this.sessionMode === 'RAG') {
      return `${header}

═══════════════════════════════════════════════════════
RULE 1 — topics_to_cover: UPDATE MASTERY SCORES (never add/remove items)
═══════════════════════════════════════════════════════
This is a FIXED syllabus. NEVER add or remove items from topics_to_cover.
For each subtopic mentioned by the professor ([model]) in the transcript delta, update its mastery_score:
  3 = student answered correctly without help
  2 = student answered partially or with hints
  1 = student didn't know / professor had to explain
  0 = not yet discussed (keep current score — don't reset to 0)

CRITICAL: Only update scores for subtopics explicitly discussed. Leave untouched subtopics at their current score.

═══════════════════════════════════════════════════════
RULE 2 — OTHER FIELDS
═══════════════════════════════════════════════════════
- KEEP session_mode unchanged (always "RAG").
- UPDATE current_topic if the professor moved to a new main topic.
- APPEND to behavioral_directives for new user preferences.
- UPDATE student_info if new data appears.
- UPDATE overall_evaluation to reflect progress.
- covered_concepts: leave empty (not used in RAG mode).
- Be concise: short phrases, not full sentences.`;
    }

    // ── Professor FREE_ROAM: track new concepts on-the-fly ───────────────
    if (this.assistantId === 'professor' && this.sessionMode === 'FREE_ROAM') {
      return `${header}

═══════════════════════════════════════════════════════
RULE 1 — current_topic
═══════════════════════════════════════════════════════
If the user changed the subject in this delta, update current_topic to the new subject.

═══════════════════════════════════════════════════════
RULE 2 — covered_concepts: TRACK NEW CONCEPTS
═══════════════════════════════════════════════════════
Identify specific concepts the professor ([model]) discussed or asked about in this delta.
Summarize each into 2-3 words (e.g. "Berlin Wall", "Dark Phase", "Legge di Ohm").
Add new concepts to covered_concepts with a mastery_score:
  3 = student answered correctly without help
  2 = student answered partially or with hints
  1 = student didn't know / professor had to explain
Do NOT duplicate concepts already in the list. If a concept was re-discussed, update its score.

═══════════════════════════════════════════════════════
RULE 3 — OTHER FIELDS
═══════════════════════════════════════════════════════
- KEEP session_mode unchanged (always "FREE_ROAM").
- topics_to_cover: leave empty (not used in FREE_ROAM mode).
- APPEND to behavioral_directives for new user preferences.
- UPDATE student_info if new data appears.
- UPDATE overall_evaluation to reflect progress.
- Be concise: short phrases, not full sentences.`;
    }

    // ── Generic prompt for all non-professor assistants ───────────────────
    return `${header}

═══════════════════════════════════════════════════════
RULE 1 — SHRINKING LISTS (topics_to_cover / artworks_to_visit)
═══════════════════════════════════════════════════════
If the schema includes a shrinking list (topics_to_cover, artworks_to_visit, etc.):
- When a subtopic/item is explicitly addressed by the [model] in the delta, REMOVE it.
- NEVER add new items. Only remove covered ones.
- If a parent has zero remaining children after removal, delete the parent entry.

═══════════════════════════════════════════════════════
RULE 2 — PERFORMANCE TRACKING
═══════════════════════════════════════════════════════
If the schema includes performance arrays (candidate_strengths, visitor_interests, etc.):
- ADD entries only based on what was explicitly demonstrated in the delta.
- Be specific and concise per entry.

═══════════════════════════════════════════════════════
RULE 3 — OTHER FIELDS
═══════════════════════════════════════════════════════
- APPEND to behavioral_directives for any new user preference or tone observation.
- UPDATE personal info fields if new data appears.
- UPDATE evaluation/impression fields to reflect current progress.
- Be concise: short phrases, not full sentences.
- Only include information explicitly present in the transcript.`;
  }

  // ── Switch emission ──────────────────────────────────────────────────────

  private emitSwitchReady(): void {
    if (!this.hasCompletedAssistantTail()) {
      console.log(
        `[${this.sessionId}] ContextManager: switch deferred until assistant turn is fully buffered.`,
      );
      return;
    }

    const payload = this.buildInjectionPayload();
    if (!payload) return;

    // ── Debug logging: show both JSON state and markdown summary ──────────
    console.log(
      `[${this.sessionId}] ContextManager: emitting switchReady at turnComplete. Buffer lines: ${this.unprocessedBuffer.length}`,
    );
    console.log(`[${this.sessionId}] ── Extracted JSON state:`);
    console.log(JSON.stringify(this.currentState, null, 2));

    if (this.assistantId === 'professor' && this.sessionMode && this.currentState) {
      const markdown = generateMarkdownSummary(this.currentState, this.sessionMode);
      console.log(`[${this.sessionId}] ── Produced Markdown summary:`);
      console.log(markdown);
    }

    this.emit('switchReady', payload);
  }
}

// ── Markdown Summary Generator (module-level, reusable) ──────────────────────
//
// Converts the professor's JSON state into a compact markdown checklist for
// injection into the Gemini Live system prompt. Reduces token overhead by ~70%
// compared to raw JSON.
//
// Exported so sessionHandler can also use it for the initial state injection.

/**
 * Mastery score → checkbox character:
 *   [ ] = 0 (untouched)
 *   [!] = 1 (gaps / professor explained)
 *   [x] = 2+ (sufficient or strong)
 */
function masteryCheckbox(score: number): string {
  if (score === 0) return '[ ]';
  if (score === 1) return '[!]';
  return '[x]';
}

export function generateMarkdownSummary(state: AnyAssistantState, mode: SessionMode): string {
  const s = state as any; // We know the shape from professorStateSchema
  const lines: string[] = [];

  // ── Header ─────────────────────────────────────────────────────────────
  lines.push(`## SESSION STATE (${mode === 'RAG' ? 'RAG Mode' : 'Free Roam'})`);
  lines.push('');

  // ── Student info ───────────────────────────────────────────────────────
  const name = s.student_info?.name || '(non fornito)';
  const level = s.student_info?.education_level || '(non fornito)';
  lines.push(`**Student:** ${name} (${level})`);

  // ── Current topic (always shown, most relevant for FREE_ROAM) ──────────
  if (s.current_topic) {
    lines.push(`**Current Topic:** ${s.current_topic}`);
  }

  // ── Evaluation ─────────────────────────────────────────────────────────
  if (s.overall_evaluation) {
    lines.push(`**Evaluation:** ${s.overall_evaluation}`);
  }
  lines.push('');

  // ── RAG mode: syllabus progress ────────────────────────────────────────
  if (mode === 'RAG' && Array.isArray(s.topics_to_cover) && s.topics_to_cover.length > 0) {
    lines.push('### Syllabus Progress');
    for (const topic of s.topics_to_cover) {
      lines.push(`#### ${topic.main_topic}`);
      if (Array.isArray(topic.subtopics)) {
        for (const sub of topic.subtopics) {
          lines.push(`- ${masteryCheckbox(sub.mastery_score)} ${sub.name} (${sub.mastery_score}/3)`);
        }
      }
    }
    lines.push('');
  }

  // ── FREE_ROAM mode: covered concepts ───────────────────────────────────
  if (mode === 'FREE_ROAM' && Array.isArray(s.covered_concepts) && s.covered_concepts.length > 0) {
    lines.push('### Covered Concepts');
    for (const c of s.covered_concepts) {
      lines.push(`- ${masteryCheckbox(c.mastery_score)} ${c.concept} (${c.mastery_score}/3)`);
    }
    lines.push('');
  } else if (mode === 'FREE_ROAM') {
    lines.push('### Covered Concepts');
    lines.push('(none yet)');
    lines.push('');
  }

  // ── Behavioural directives ─────────────────────────────────────────────
  if (Array.isArray(s.behavioral_directives) && s.behavioral_directives.length > 0) {
    lines.push(`**Directives:** ${s.behavioral_directives.join('; ')}`);
  }

  // ── Language ───────────────────────────────────────────────────────────
  if (s.user_language) {
    lines.push(`**Language:** ${s.user_language}`);
  }

  return lines.join('\n');
}
