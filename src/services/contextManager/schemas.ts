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
  /** Key topics or themes discussed so far. */
  topics_covered: z.array(z.string()).describe('List of topics or themes that have been discussed so far.'),
};

// ── Professor ────────────────────────────────────────────────────────────────

export const professorStateSchema = z.object({
  ...baseFields,
  student_name: z.string().optional().describe('Name of the student, if provided.'),
  education_level: z.string().optional().describe('Education level declared by the student (e.g. high-school, university).'),
  current_subject: z.string().optional().describe('The subject / macro-topic currently being examined.'),
  questions_asked: z.number().describe('How many questions the professor has asked so far.'),
  correct_answers: z.number().describe('How many of those questions were answered correctly.'),
  weak_areas: z.array(z.string()).describe('Topics where the student showed weakness.'),
  strong_areas: z.array(z.string()).describe('Topics where the student answered well.'),
  grade_given: z.string().optional().describe('If a final grade was already given, store it here.'),
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
});

// ── Audioguide ───────────────────────────────────────────────────────────────

export const audioguideStateSchema = z.object({
  ...baseFields,
  museum_or_site: z.string().optional().describe('Name of the museum or cultural site.'),
  current_artwork: z.string().optional().describe('The artwork or exhibit currently being described.'),
  artworks_visited: z.array(z.string()).describe('Artworks / exhibits already described in this session.'),
  visitor_interests: z.array(z.string()).describe('Topics or details the visitor showed particular interest in.'),
});

// ── Immigration Assistant ────────────────────────────────────────────────────

export const immigrationAssistantStateSchema = z.object({
  ...baseFields,
  user_situation: z.string().optional().describe('Brief summary of the user\'s situation as understood so far.'),
  steps_given: z.array(z.string()).describe('Practical steps already communicated to the user.'),
  pending_questions: z.array(z.string()).describe('Questions the assistant still needs to clarify with the user.'),
  referrals: z.array(z.string()).describe('Offices or associations the user was referred to.'),
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
