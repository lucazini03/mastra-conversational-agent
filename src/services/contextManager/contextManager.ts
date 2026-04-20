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
import { getSchemaForAssistant, type AnyAssistantState } from './schemas.js';

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

    const extractionPrompt = `You are a memory extraction engine for a voice conversation. You receive the current JSON state and a new transcript delta. You must output the updated state.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT STATE:
${existingStateJSON}

NEW TRANSCRIPT DELTA (roles: [model] = assistant/professor, [user] = student/visitor):
${deltaText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

═══════════════════════════════════════════════════════
RULE 1 — strong_areas / weak_areas: STUDENT PERFORMANCE ONLY
═══════════════════════════════════════════════════════
These fields measure what THE STUDENT (role=[user]) demonstrated on their own.

strong_areas: add an entry ONLY when the student spontaneously and correctly answered a question WITHOUT being told the answer first.
weak_areas:   add an entry when:
  - the student said they don't know / couldn't answer, OR
  - the student gave a wrong answer, OR
  - the professor ([model]) had to explain the topic because the student didn't know it.

CRITICAL: If the sequence is "[model] asks → [user] says 'I don't know' or 'dimmelo tu' → [model] explains", this is a WEAK area (student did NOT know it). Do NOT add it to strong_areas. The fact that the professor explained something does not mean the student understood it beforehand.

═══════════════════════════════════════════════════════
RULE 2 — topics_to_cover / artworks_to_visit: MANDATORY REMOVAL
═══════════════════════════════════════════════════════
This is a SHRINKING TODO list. Your primary duty is to remove items from it as they are covered.

DEFINITION OF "COVERED": A subtopic is covered when the professor ([model]) explicitly asked about it or addressed it in this transcript delta. It does not matter if the student answered correctly, incorrectly, or not at all — the moment the professor touched it, it is covered and MUST be removed.

REMOVAL PROCEDURE — execute this for every subtopic in the list:
  Step 1. Name the subtopic.
  Step 2. Search the transcript delta for any [model] turn that mentions it, asks about it, or explains it.
  Step 3. Found? → REMOVE this subtopic from the list.
           Not found? → KEEP it unchanged.
  Step 4. If a main_topic has zero remaining subtopics after removal, delete the entire main_topic entry.

NEVER add new items. Only remove.

CONCRETE EXAMPLE:
  Before state:
    topics_to_cover: [{ main_topic: "Vettori", subtopics: ["Definizione", "Modulo", "Vettore nullo"] }]
    strong_areas: [], weak_areas: []

  Transcript delta:
    [model]: Come definisce un vettore?
    [user]: Non me lo ricordo.
    [model]: Un vettore è un ente geometrico con modulo, direzione e verso.
    [model]: Sa dirmi cos'è il vettore nullo?
    [user]: È il vettore le cui componenti sono tutte zero.
    [model]: Esatto.

  Correct output:
    topics_to_cover: [{ main_topic: "Vettori", subtopics: ["Modulo"] }]
    ← "Definizione" removed because [model] asked about it; "Vettore nullo" removed because [model] asked about it; "Modulo" kept because it was never mentioned.
    strong_areas: ["Vettore nullo: risposta corretta."]
    weak_areas:   ["Definizione di vettore: lo studente non ricordava, il professore ha spiegato."]

  WRONG output (do NOT produce this):
    topics_to_cover: [{ main_topic: "Vettori", subtopics: ["Definizione", "Modulo", "Vettore nullo"] }]
    ← ERROR: items were discussed but not removed.

═══════════════════════════════════════════════════════
RULE 3 — OTHER FIELDS
═══════════════════════════════════════════════════════
- APPEND to behavioral_directives for any new user preference or tone observation.
- UPDATE student_info / visitor_info if new data appears.
- UPDATE overall_evaluation to reflect current progress.
- Be concise: short phrases, not full sentences.
- Only include information explicitly present in the transcript.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
SELF-CHECK before outputting: Count the subtopics the professor mentioned in the delta. Verify that exact number of subtopics was removed from topics_to_cover. If your output has the same number of subtopics as the current state, you made an error — go back and remove the covered ones.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

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

    console.log(
      `[${this.sessionId}] ContextManager: extraction succeeded. Extracted state:`,
    );
    console.log(JSON.stringify(this.currentState, null, 2));

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
      `3. Do NOT call any search or document tool (e.g. search_documents) to retrieve information already present in the Compact State below — it was already retrieved earlier in this session.\n` +
      `4. Consult the CONVERSATION MEMORY below to understand where you are in the conversation and continue seamlessly from that point.\n` +
      `5. Your next action must be a DIRECT CONTINUATION — respond to the user's last message or wait quietly for their input.`,
    );

    // 3. Compact memory (JSON state)
    sections.push(
      `\n---\n## CONVERSATION MEMORY (Compact State)\nThe following JSON represents the accumulated state of this conversation so far. Use it to maintain continuity — do NOT ask the user to repeat information already captured here.\n\n\`\`\`json\n${JSON.stringify(state, null, 2)}\n\`\`\``,
    );

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

    console.log(
      `[${this.sessionId}] ContextManager: emitting switchReady at turnComplete. Buffer lines: ${this.unprocessedBuffer.length}`,
    );

    this.emit('switchReady', payload);
  }
}
