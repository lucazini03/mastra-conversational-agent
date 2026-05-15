// src/services/contextManager/contextManager.ts
//
// Utility functions for context compaction in the serverless architecture.
// The ContextManager class has been removed — compaction is now handled
// directly by the /api/voice/compact route + useGeminiLive hook state machine.

import type { AnyAssistantState, SessionMode } from './schemas.js';

// ── Markdown Summary Generator ────────────────────────────────────────────────
//
// Converts the professor's JSON state into a compact markdown checklist for
// injection into the Gemini Live system prompt. Reduces token overhead by ~70%
// compared to raw JSON.

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
