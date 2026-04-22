// src/services/contextManager/schemas.ts
//
// Zod schema for compact professor memory state.

import { z } from 'zod';
import type { AssistantId } from '../../config/professorConfig.js';

// ── Session mode (professor-only) ────────────────────────────────────────────
// RAG       = document-based syllabus with pre-defined topics_to_cover
// FREE_ROAM = knowledge-based exploration, concepts discovered on-the-fly

export type SessionMode = 'RAG' | 'FREE_ROAM';

// ── Shared fields present in every assistant schema ──────────────────────────

const baseFields = {
  /** Free-form behavioural directives observed during the conversation.
   *  e.g. "User asked for a formal tone", "Switch to English". */
  behavioral_directives: z.array(z.string()).describe(
    'Behavioural observations & directives the assistant should carry forward. E.g. "User asked for a formal tone", "User prefers examples over definitions".',
  ),
  /** The language the user is currently speaking / last spoke in. */
  user_language: z.string().describe('ISO-639-1 code or natural-language name of the language the user is currently using.'),
};

// ── Mastery score (shared by topics_to_cover subtopics and covered_concepts) ─
// 0 = untouched
// 1 = major gaps / professor had to explain
// 2 = sufficient understanding
// 3 = strong understanding

// ── Professor ────────────────────────────────────────────────────────────────

export const professorStateSchema = z.object({
  ...baseFields,

  /** RAG or FREE_ROAM — set at session start, never changes. */
  session_mode: z.enum(['RAG', 'FREE_ROAM']).describe(
    'Session mode. RAG = document-based syllabus. FREE_ROAM = knowledge-based exploration.',
  ),

  student_info: z.object({
    name: z.string().describe('Name of the student, if provided.'),
    education_level: z.string().describe('Education level declared by the student (e.g. high-school, university).'),
  }).describe('Basic information about the student.'),

  /** The main subject currently being discussed. Critical in FREE_ROAM mode. */
  current_topic: z.string().describe(
    'The main subject currently being discussed. Updated when the student changes subject.',
  ),

  /** Pre-defined syllabus from documents (RAG mode).
   *  Items are NEVER removed — their mastery_score is updated instead. */
  topics_to_cover: z.array(z.object({
    main_topic: z.string().describe('Main topic or chapter.'),
    subtopics: z.array(z.object({
      name: z.string().describe('Subtopic name.'),
      mastery_score: z.number().min(0).max(3).describe(
        '0=untouched, 1=major gaps/professor explained, 2=sufficient, 3=strong understanding.',
      ),
    })).describe('Subtopics with mastery scores.'),
  })).describe(
    'FIXED syllabus from documents (RAG mode). Items are NEVER added or removed; update mastery_score instead.',
  ),

  /** Concepts discovered on-the-fly during FREE_ROAM sessions. */
  covered_concepts: z.array(z.object({
    concept: z.string().describe('Short concept label (2-3 words, e.g. "Berlin Wall", "Dark Phase").'),
    mastery_score: z.number().min(0).max(3).describe(
      '0=untouched, 1=major gaps/professor explained, 2=sufficient, 3=strong understanding.',
    ),
  })).describe(
    'Concepts discovered on-the-fly during FREE_ROAM sessions. Add new ones as they are discussed.',
  ),

  overall_evaluation: z.string().describe('Running synthesis of the student performance. Update after each verified topic.'),
});

// ── Schema registry ──────────────────────────────────────────────────────────

export const ASSISTANT_STATE_SCHEMAS = {
  professor: professorStateSchema,
} as const satisfies Record<AssistantId, z.ZodType>;

export type AssistantStateSchemas = typeof ASSISTANT_STATE_SCHEMAS;

/** Inferred TypeScript type for a given assistant's compact state. */
export type AssistantState<T extends AssistantId> = z.infer<AssistantStateSchemas[T]>;

/** Union of all possible states. */
export type AnyAssistantState = AssistantState<AssistantId>;

export function getSchemaForAssistant(assistantId: AssistantId) {
  return ASSISTANT_STATE_SCHEMAS[assistantId];
}
