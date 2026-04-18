// src/services/contextManager/schemas.ts
//
// Zod schemas for the compact memory state per assistant persona.
// Each schema defines what the lightweight extraction model should produce
// when summarising a conversation delta. All schemas include the mandatory
// `behavioral_directives` field.

import { z } from 'zod';
import type { AssistantId } from '../../config/professorConfig.js';

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

// ── Professor ────────────────────────────────────────────────────────────────

export const professorStateSchema = z.object({
  ...baseFields,
  student_info: z.object({
    name: z.string().describe('Name of the student, if provided.'),
    education_level: z.string().describe('Education level declared by the student (e.g. high-school, university).'),
  }).describe('Basic information about the student.'),
  topics_to_cover: z.array(z.object({
    main_topic: z.string().describe('Main topic or chapter still to be examined.'),
    subtopics: z.array(z.string()).describe('Subtopics or concepts within this main topic that still need to be covered.'),
  })).describe(
    'DECREASING list of remaining topics. When a topic/subtopic has been discussed and verified (positively or negatively), REMOVE it from this list and record the outcome in strong_areas or weak_areas instead. Never add new items here.',
  ),
  strong_areas: z.array(z.string()).describe('Topics where the student answered well — include brief feedback per entry.'),
  weak_areas: z.array(z.string()).describe('Topics where the student showed weakness or gaps — include brief feedback per entry.'),
  overall_evaluation: z.string().describe('Running synthesis of the student performance. Update after each verified topic.'),
});

// ── Interview Coach ──────────────────────────────────────────────────────────

export const interviewCoachStateSchema = z.object({
  ...baseFields,
  company_name: z.string().optional().describe('Name of the company extracted from documents.'),
  role_title: z.string().optional().describe('Job role title being interviewed for.'),
  interview_phase: z.string().optional().describe('Current phase: opening, motivational, STAR, technical, expectations, closing, feedback.'),
  questions_asked: z.number().describe('Number of interview questions asked.'),
  candidate_strengths: z.array(z.string()).describe('Strengths observed in the candidate.'),
  candidate_weaknesses: z.array(z.string()).describe('Weaknesses or gaps observed.'),
  star_responses_quality: z.string().optional().describe('General quality assessment of STAR method responses.'),
  optional_notes: z.string().optional().describe('Any [optional] additional notes or observations the coach should keep in mind.'),
});

// ── Study Tutor ──────────────────────────────────────────────────────────────

export const studyTutorStateSchema = z.object({
  ...baseFields,
  student_name: z.string().optional().describe('Name of the student, if provided.'),
  current_topic: z.string().optional().describe('The topic currently being studied / explained.'),
  mode: z.string().optional().describe('Current interaction mode: explaining, quizzing, reviewing.'),
  concepts_understood: z.array(z.string()).describe('Concepts the student has demonstrated understanding of.'),
  concepts_struggling: z.array(z.string()).describe('Concepts the student is still struggling with.'),
  analogies_used: z.array(z.string()).describe('Analogies or examples that were effective.'),
  optional_notes: z.string().optional().describe('Any [optional] additional notes or observations the tutor should keep in mind.'),
});

// ── Audioguide ───────────────────────────────────────────────────────────────

export const audioguideStateSchema = z.object({
  ...baseFields,
  visitor_info: z.object({
    name: z.string().describe('Name of the visitor, if provided.'),
    preferences: z.string().describe('Visitor preferences or visit style (e.g. fast, detailed, interactive).'),
  }).describe('Basic information about the visitor.'),
  artworks_to_visit: z.array(z.object({
    artwork_name: z.string().describe('Name of the artwork, exhibit, or room still to be described.'),
    highlights: z.array(z.string()).describe('Key aspects or details of this artwork not yet described.'),
  })).describe(
    'DECREASING list of remaining artworks/exhibits. When an artwork has been fully described, REMOVE it from this list and record visitor reactions in visitor_interests or confusing_aspects instead. Never add new items here.',
  ),
  visitor_interests: z.array(z.string()).describe('Aspects, artworks, or topics the visitor showed particular interest in — with brief notes per entry.'),
  confusing_aspects: z.array(z.string()).describe('Aspects or artworks the visitor found confusing or needed clarification on — with brief notes per entry.'),
  overall_impression: z.string().describe('Running synthesis of the visit experience so far.'),
});

// ── Immigration Assistant ────────────────────────────────────────────────────

export const immigrationAssistantStateSchema = z.object({
  ...baseFields,
  user_situation: z.string().optional().describe('Brief summary of the user\'s situation as understood so far.'),
  steps_given: z.array(z.string()).describe('Practical steps already communicated to the user.'),
  pending_questions: z.array(z.string()).describe('Questions the assistant still needs to clarify with the user.'),
  referrals: z.array(z.string()).describe('Offices or associations the user was referred to.'),
  optional_notes: z.string().optional().describe('Any [optional] additional notes or observations the assistant should keep in mind.'),
});

// ── Language Tutor ───────────────────────────────────────────────────────────

export const languageTutorStateSchema = z.object({
  ...baseFields,
  target_language: z.string().optional().describe('The language the user is practicing.'),
  proficiency_level: z.string().optional().describe('Declared or estimated proficiency level.'),
  scenario: z.string().optional().describe('Current conversation scenario if any (e.g. "at the airport").'),
  corrections_made: z.array(z.string()).describe('Grammar or vocabulary corrections given during the session.'),
  recurring_errors: z.array(z.string()).describe('Error patterns that keep repeating.'),
  vocabulary_introduced: z.array(z.string()).describe('New words or phrases the tutor introduced.'),
  optional_notes: z.string().optional().describe('Any [optional] additional notes or observations the tutor should keep in mind.'),
});

// ── Schema registry ──────────────────────────────────────────────────────────

export const ASSISTANT_STATE_SCHEMAS = {
  professor: professorStateSchema,
  interview_coach: interviewCoachStateSchema,
  study_tutor: studyTutorStateSchema,
  audioguide: audioguideStateSchema,
  immigration_assistant: immigrationAssistantStateSchema,
  language_tutor: languageTutorStateSchema,
} as const satisfies Record<AssistantId, z.ZodType>;

export type AssistantStateSchemas = typeof ASSISTANT_STATE_SCHEMAS;

/** Inferred TypeScript type for a given assistant's compact state. */
export type AssistantState<T extends AssistantId> = z.infer<AssistantStateSchemas[T]>;

/** Union of all possible states. */
export type AnyAssistantState = AssistantState<AssistantId>;

export function getSchemaForAssistant(assistantId: AssistantId) {
  return ASSISTANT_STATE_SCHEMAS[assistantId];
}
