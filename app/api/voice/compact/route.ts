// app/api/voice/compact/route.ts
//
// Context compaction endpoint: Stage 1 of the two-stage context switch.
//
// Accepts the conversation transcript and current state, runs the extraction
// LLM (a cheap lite model), and returns the new compact state.
// This is called by the browser BEFORE turnComplete (preemptively, while the
// user is still speaking) to hide the LLM latency.
//
// Stage 2 (assembling the system instruction + minting a new token) is handled
// by POST /api/voice/token with { compactState, bufferTurns } in the body.
// That call happens AT turnComplete, once the buffer turns are finalized.

import { NextRequest, NextResponse } from 'next/server';
import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { isAssistantId, type AssistantId } from '@/src/config/professorConfig';
import { getSchemaForAssistant, type AnyAssistantState, type SessionMode } from '@/src/services/contextManager/index';

// ── Environment config ────────────────────────────────────────────────────────
const MEMORY_EXTRACTION_MODEL =
  process.env.MEMORY_EXTRACTION_MODEL ?? 'gemini-3.1-flash-lite-preview';
const MEMORY_EXTRACTION_MODEL_BACKUP =
  process.env.MEMORY_EXTRACTION_MODEL_BACKUP ?? 'gemini-2.5-flash-lite';

// ── Types ─────────────────────────────────────────────────────────────────────
type TranscriptEntry = { role: 'user' | 'model'; text: string; turnIndex: number };

type CompactRequestBody = {
  assistantId: string;
  sessionMode?: SessionMode;
  transcript: TranscriptEntry[];
  currentState: AnyAssistantState | null;
  lastExtractionTurnIndex: number;
};

// ── Extraction prompt builders ────────────────────────────────────────────────
// These are identical to the private methods in ContextManager — they are
// duplicated here to keep the API route fully stateless (no class instance needed).

function buildExtractionPrompt(
  assistantId: AssistantId,
  sessionMode: SessionMode | undefined,
  existingStateJSON: string,
  deltaText: string,
): string {
  const header = `You are a memory extraction engine for a voice conversation. You receive the current JSON state and a new transcript delta. You must output the updated state.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT STATE:
${existingStateJSON}

NEW TRANSCRIPT DELTA (roles: [model] = assistant, [user] = user):
${deltaText}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;

  if (assistantId === 'professor' && sessionMode === 'RAG') {
    return `${header}

═══════════════════════════════════════════════════════
RULE 1 — topics_to_cover: UPDATE MASTERY SCORES (never add/remove items)
═══════════════════════════════════════════════════════
This is a FIXED syllabus. NEVER add or remove items from topics_to_cover.
For each subtopic mentioned by the [model] in the delta, update its mastery_score:
  3 = student answered correctly without help
  2 = student answered partially or with hints
  1 = student didn't know / professor had to explain
  0 = not yet discussed (keep current score — don't reset to 0)
CRITICAL: Only update scores for subtopics explicitly discussed.

═══════════════════════════════════════════════════════
RULE 2 — OTHER FIELDS
═══════════════════════════════════════════════════════
- KEEP session_mode = "RAG".
- UPDATE current_topic if the professor moved to a new main topic.
- APPEND to behavioral_directives for new user preferences.
- UPDATE student_info and overall_evaluation.
- covered_concepts: leave empty (not used in RAG mode).
- Be concise: short phrases, not full sentences.`;
  }

  if (assistantId === 'professor' && sessionMode === 'FREE_ROAM') {
    return `${header}

═══════════════════════════════════════════════════════
RULE 1 — current_topic: Update if user changed subject.
═══════════════════════════════════════════════════════

═══════════════════════════════════════════════════════
RULE 2 — covered_concepts: TRACK NEW CONCEPTS (2-3 words each)
═══════════════════════════════════════════════════════
Add new concepts with mastery_score (3/2/1). Don't duplicate. Update if re-discussed.

═══════════════════════════════════════════════════════
RULE 3 — OTHER FIELDS
═══════════════════════════════════════════════════════
- KEEP session_mode = "FREE_ROAM".
- topics_to_cover: leave empty.
- APPEND to behavioral_directives. UPDATE student_info and overall_evaluation.
- Be concise.`;
  }

  return `${header}

═══════════════════════════════════════════════════════
RULE 1 — SHRINKING LISTS
═══════════════════════════════════════════════════════
Remove items from shrinking lists (artworks_to_visit, etc.) when [model] explicitly covers them. Never add. Remove empty parents.

═══════════════════════════════════════════════════════
RULE 2 — PERFORMANCE TRACKING
═══════════════════════════════════════════════════════
ADD entries to tracking arrays only from what was explicitly demonstrated. Be specific and concise.

═══════════════════════════════════════════════════════
RULE 3 — OTHER FIELDS
═══════════════════════════════════════════════════════
APPEND to behavioral_directives. UPDATE personal info and evaluation. Be concise.`;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body: CompactRequestBody = await req.json();
    const {
      assistantId: rawAssistantId,
      sessionMode,
      transcript,
      currentState,
      lastExtractionTurnIndex,
    } = body;

    if (!isAssistantId(rawAssistantId)) {
      return NextResponse.json({ error: 'Invalid assistantId' }, { status: 400 });
    }
    const assistantId: AssistantId = rawAssistantId;

    if (!Array.isArray(transcript) || transcript.length === 0) {
      return NextResponse.json({ error: 'transcript array required' }, { status: 400 });
    }

    // Extract only the delta turns since the last extraction.
    const deltaEntries = transcript.filter((e) => e.turnIndex > (lastExtractionTurnIndex ?? -1));

    if (deltaEntries.length === 0) {
      return NextResponse.json(
        { error: 'No new transcript turns to extract' },
        { status: 422 },
      );
    }

    const deltaText = deltaEntries.map((e) => `[${e.role}]: ${e.text}`).join('\n');
    const lastTurnIndex = deltaEntries[deltaEntries.length - 1].turnIndex;

    const existingStateJSON = currentState
      ? JSON.stringify(currentState, null, 2)
      : 'null (first extraction — create the state from scratch)';

    const extractionPrompt = buildExtractionPrompt(
      assistantId,
      sessionMode,
      existingStateJSON,
      deltaText,
    );

    const schema = getSchemaForAssistant(assistantId);

    // Try primary model then backup.
    const modelCandidates = [MEMORY_EXTRACTION_MODEL, MEMORY_EXTRACTION_MODEL_BACKUP].filter(
      (v, i, a) => v.trim().length > 0 && a.indexOf(v) === i,
    );

    let extractedObject: AnyAssistantState | null = null;
    let extractionModel: string | null = null;
    let lastError: unknown = null;

    const google = createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_LLM_API_KEY ?? '',
    });

    for (const modelName of modelCandidates) {
      try {
        const { object } = await generateObject({
          model: google(modelName),
          schema,
          prompt: extractionPrompt,
        });
        extractedObject = object as AnyAssistantState;
        extractionModel = modelName;
        break;
      } catch (err) {
        lastError = err;
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[/api/voice/compact] extraction failed with ${modelName}: ${msg}`);
      }
    }

    if (!extractedObject) {
      const message =
        lastError instanceof Error ? lastError.message : String(lastError ?? 'Unknown error');
      console.error('[/api/voice/compact] All models failed:', message);
      return NextResponse.json({ error: `Extraction failed: ${message}` }, { status: 502 });
    }

    return NextResponse.json({
      compactState: extractedObject,
      extractionModel,
      /** The turn index of the last entry included in this extraction.
       *  The browser should store this and pass it as lastExtractionTurnIndex
       *  on the next /compact call.                                         */
      lastTurnIndex,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/voice/compact] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
