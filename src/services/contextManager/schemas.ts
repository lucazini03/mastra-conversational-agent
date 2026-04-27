// src/services/contextManager/schemas.ts
//
// Zod schema for compact interview coach memory state.

import { z } from 'zod';
import type { AssistantId } from '../../config/interviewConfig.js';

export const interviewCoachStateSchema = z.object({
  behavioral_directives: z.array(z.string()).describe(
    'Behavioural observations and directives to carry forward. E.g. "Candidate prefers English", "Candidate is nervous, slow the pace".',
  ),
  user_language: z.string().describe('ISO-639-1 code or natural-language name of the language the candidate is currently using.'),
  candidate_info: z.object({
    name: z.string().describe('Name of the candidate, if provided.'),
    background: z.string().describe('Brief background summary inferred from the conversation (experience level, domain, education, etc.).'),
  }).describe('Basic information about the candidate.'),
  current_phase: z.string().describe('Name of the current interview phase being conducted (e.g. "Introduction", "Technical Deep-Dive").'),
  questions_asked: z.array(z.object({
    question: z.string().describe('The exact question that was asked.'),
    answer_summary: z.string().describe("Brief summary of the candidate's answer (2-3 sentences max)."),
    phase: z.string().describe('Interview phase this question belongs to.'),
  })).describe('All questions asked so far with summaries of candidate answers. Append new ones; never remove existing ones.'),
  overall_impression: z.string().describe("Running synthesis of the candidate's performance. Update after each significant exchange."),
});

export const ASSISTANT_STATE_SCHEMAS = {
  interview_coach: interviewCoachStateSchema,
} as const satisfies Record<AssistantId, z.ZodType>;

export type AssistantStateSchemas = typeof ASSISTANT_STATE_SCHEMAS;

export type AssistantState<T extends AssistantId> = z.infer<AssistantStateSchemas[T]>;

export type AnyAssistantState = AssistantState<AssistantId>;

export function getSchemaForAssistant(assistantId: AssistantId) {
  return ASSISTANT_STATE_SCHEMAS[assistantId];
}

