// src/services/contextManager/initialState.ts
//
// Builds the initial AnyAssistantState for the professor at session start,
// seeding topics_to_cover from the DocumentIndex produced by documentService.
//
// Imported by the token API route for the initial token mint only.
// Compaction remints use the existing compactState returned by /api/voice/compact.

import type { DocumentIndex } from '../../server/documentService.js';
import type { AnyAssistantState, SessionMode } from './schemas.js';

/**
 * Build an initial professor state from a DocumentIndex.
 *
 * In RAG mode: topics_to_cover is pre-populated from the index (mastery = 0).
 * In FREE_ROAM mode: topics_to_cover is empty; covered_concepts used instead.
 */
export function buildInitialProfessorState(
  index: DocumentIndex,
  sessionMode: SessionMode,
): AnyAssistantState {
  const topicsToCover =
    sessionMode === 'RAG'
      ? index.main_topics.map((t) => ({
          main_topic: t.topic,
          subtopics: (t.subtopics ?? []).map((name) => ({
            name,
            mastery_score: 0,
          })),
        }))
      : [];

  return {
    session_mode: sessionMode,
    student_info: {
      name: '',
      education_level: '',
    },
    current_topic: index.main_topics[0]?.topic ?? '',
    topics_to_cover: topicsToCover,
    covered_concepts: [],
    behavioral_directives: [],
    user_language: 'it',
    overall_evaluation: '',
  } satisfies import('./schemas.js').AssistantState<'professor'>;
}
