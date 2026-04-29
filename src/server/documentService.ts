// src/server/documentService.ts
//
// Singleton service responsible for:
//   1. Reading selected files (PDF/TXT/MD), extracting and normalising text.
//   2. Computing a stable SHA-256 hash of the combined content.
//   3. Generating (and caching to disk) an LLM document summary used to
//      inject a topic-constraint into agent instructions at session start,
//      mitigating "parametric bleed" / hallucinations.
//
// The in-memory content cache means subsequent calls within the same
// process lifetime (e.g. from ragService + sessionHandler) are free.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { generateObject } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { z } from 'zod';
import { parseDocumentFile } from './documentFileUtils.js';

// ── Schema & types ────────────────────────────────────────────────────────────

export const DocumentIndexSchema = z.object({
  main_topics: z
    .array(
      z.object({
        topic: z.string().describe('Main topic/chapter title as written in the source text'),
        subtopics: z
          .array(z.string())
          .describe('Short list of subtopics explicitly covered under this topic'),
      }),
    )
    .describe('Detailed topic outline extracted from the document'),
});

export type DocumentIndex = z.infer<typeof DocumentIndexSchema>;

export const InterviewStructureSchema = z.object({
  role_title: z.string().describe('The exact job title from the job description.'),
  company_name: z.string().describe('Company name extracted from the job description, or empty string if not found.'),
  culture_notes: z.string().describe('Brief notes on company culture, values, or team dynamics mentioned in the JD.'),
  job_responsibilities: z.array(z.string()).describe('Key responsibilities listed in the JD.'),
  required_skills: z.array(z.string()).describe('Specific skills, qualifications, or technologies mentioned in the JD.'),
  required_experience: z.string().describe('Summary of required experience level and background.'),
  phases: z.array(z.object({
    phase_name: z.string().describe('Name of this interview phase (e.g. "Introduction", "Technical Deep-Dive", "Behavioural", "Closing").'),
    question_seeds: z.array(z.string()).describe('3-5 representative questions to ask in this phase, grounded in the JD.'),
    //evaluation_criteria: z.array(z.string()).describe('2-3 criteria to assess the candidate on in this phase.'),
  })).describe('Ordered interview phases covering the full conversation flow.'),
});

export type InterviewStructure = z.infer<typeof InterviewStructureSchema>;

export type DocsContent = {
  /** SHA-256 of the combined, normalised text of all PDFs. */
  hash: string;
  /** Combined normalised text used for summary generation. */
  text: string;
  /** Per-file breakdown preserved for vector chunking (with sourceFile metadata). */
  files: Array<{ name: string; normalizedText: string }>;
};

export type SummaryResult = {
  index: DocumentIndex | null;
  /** Non-null only when generation ran (not served from disk cache). */
  generationTokens: { input: number; output: number } | null;
};

export type InterviewStructureResult = {
  structure: InterviewStructure | null;
  generationTokens: { input: number; output: number } | null;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const SUMMARIES_DIR = path.join(process.cwd(), 'logs', 'summaries');

// ── Service ───────────────────────────────────────────────────────────────────

class DocumentService {
  private googleClient: ReturnType<typeof createGoogleGenerativeAI> | null = null;

  /** In-memory cache by sorted file-path list, cleared on process restart. */
  private contentCache = new Map<string, DocsContent>();

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private getGoogleClient(): ReturnType<typeof createGoogleGenerativeAI> {
    if (!this.googleClient) {
      const apiKey = process.env.GEMINI_LLM_API_KEY;
      if (!apiKey) {
        throw new Error('[DocumentService] GEMINI_LLM_API_KEY is required for summary generation.');
      }
      this.googleClient = createGoogleGenerativeAI({ apiKey });
    }
    return this.googleClient;
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  async getDocumentsHashAndText(documentPaths: string[]): Promise<DocsContent> {
    const normalizedPaths = [...new Set(documentPaths.map((p) => path.resolve(p)))].sort();
    if (normalizedPaths.length === 0) {
      return { hash: 'no-docs', text: '', files: [] };
    }

    const cacheKey = normalizedPaths.join('|');
    const cached = this.contentCache.get(cacheKey);
    if (cached) return cached;

    const files: Array<{ name: string; normalizedText: string }> = [];

    for (const filePath of normalizedPaths) {
      const name = path.basename(filePath);
      try {
        const parsed = await parseDocumentFile(filePath);
        if (parsed?.normalizedText) {
          files.push({ name: parsed.name, normalizedText: parsed.normalizedText });
        }
      } catch (err) {
        console.warn(
          `[DocumentService] Failed to parse ${name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (files.length === 0) {
      const empty: DocsContent = { hash: 'no-docs', text: '', files: [] };
      this.contentCache.set(cacheKey, empty);
      return empty;
    }

    const combinedText = files.map((f) => f.normalizedText).join('\n\n');
    const hash = createHash('sha256').update(combinedText).digest('hex');

    const result: DocsContent = { hash, text: combinedText, files };
    this.contentCache.set(cacheKey, result);

    console.log(
      `[DocumentService] Loaded ${files.length} document(s), hash ${hash.slice(0, 12)}...`,
    );

    return result;
  }

  /**
   * Returns a cached DocumentIndex summary for the given document hash.
   * On a cache miss, generates one via Gemini and persists it to
   * logs/summaries/<hash>_summary.json so subsequent startups are instant.
   *
   * Returns a `SummaryResult` where `generationTokens` is non-null only when
   * an actual LLM call was made (cache miss). Callers can use this to track costs.
   */
  async getOrGenerateSummary(hash: string, fullText: string): Promise<SummaryResult> {
    if (!fullText || hash === 'no-docs') return { index: null, generationTokens: null };

    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
    const cacheFile = path.join(SUMMARIES_DIR, `${hash}_summary.json`);

    // ── Cache hit ─────────────────────────────────────────────────────────
    try {
      const raw = await fs.readFile(cacheFile, 'utf-8');
      const parsed = DocumentIndexSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        console.log(`[DocumentService] Summary cache hit (hash ${hash.slice(0, 12)}...)`);
        return { index: parsed.data, generationTokens: null };
      }
    } catch {
      // File absent or corrupt — fall through to generation.
    }

    // ── Cache miss: generate via Gemini ───────────────────────────────────
    console.log(`[DocumentService] Generating summary (hash ${hash.slice(0, 12)}...)...`);
    try {
      const google = this.getGoogleClient();
      const model = google('gemini-3.1-flash-lite-preview');

      const { object, usage } = await generateObject({
        model,
        schema: DocumentIndexSchema,
        prompt: [
          'Extract a detailed topic outline of the following document.',
          'Return only topics and subtopics that are explicitly written in the source text.',
          'Do NOT invent concepts not explicitly written in the text.',
          'Keep each subtopic concise, keyword-like, and useful for retrieval/search.',
          '',
          fullText,
        ].join('\n'),
      });

      await fs.writeFile(cacheFile, JSON.stringify(object, null, 2), 'utf-8');
      console.log(`[DocumentService] Summary saved to ${cacheFile}`);
      return {
        index: object,
        generationTokens: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
      };
    } catch (err) {
      console.error(
        '[DocumentService] Summary generation failed:',
        err instanceof Error ? err.message : String(err),
      );
      return { index: null, generationTokens: null };
    }
  }
  /**
   * Generates (and caches) a structured interview plan for the given job
   * description text. Results are cached by content hash so repeated calls
   * within the same or future process lifetimes are instant.
   */
  async generateInterviewStructure(text: string): Promise<InterviewStructureResult> {
    if (!text.trim()) return { structure: null, generationTokens: null };

    const hash = createHash('sha256').update(text).digest('hex');
    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
    const cacheFile = path.join(SUMMARIES_DIR, `${hash}_job_description.json`);

    try {
      const raw = await fs.readFile(cacheFile, 'utf-8');
      const parsed = InterviewStructureSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        console.log(`[DocumentService] Interview structure cache hit (hash ${hash.slice(0, 12)}...)`);
        return { structure: parsed.data, generationTokens: null };
      }
    } catch {
      // File absent or corrupt — fall through to generation.
    }

    console.log(`[DocumentService] Generating interview structure (hash ${hash.slice(0, 12)}...)...`);
    try {
      const google = this.getGoogleClient();
      const model = google('gemini-3.1-flash-lite-preview');

      const { object, usage } = await generateObject({
        model,
        schema: InterviewStructureSchema,
        prompt: [
          'You are an elite Talent Acquisition Director and Domain-Specific Senior Interviewer. Your task is to design a highly realistic, tailored interview plan based on the provided Job Description (JD).',
          '',
          'Before writing the plan, analyze the company and the role. You must adapt the interview structure to match real-world practices for that specific company type (e.g., Big Tech uses Leetcode/System Design + core principles; Academia requires research/chalk talks; Startups focus on agility and portfolio impact).',
          '',
          'OUTPUT FORMAT:',
          '',
          '[COMPANY & ROLE ANALYSIS]',
          'Briefly state the inferred company culture, the standard industry interview format for this specific tier/role, and the top 3 core competencies to be assessed.',
          '',
          '[THE INTERVIEW PLAN]',
          'REQUIRED STRUCTURE — strictly follow these phases in order:',
          '',
          '1. Introduction',
          '- The interviewer asks the candidate to introduce themselves, describe their career path, and explain their motivation for this specific role and company. (Do NOT ask what role they are applying for).',
          '- Include 2-3 specific question seeds probing their background, trajectory, and motivation based on the JD.',
          '- Evaluation: What specific green flags and red flags should the interviewer listen for here?',
          '',
          '2. Role-Specific Assessment Phases (2-4 Phases)',
          "- Create 2 to 4 distinct phases drawn directly from the JD's skills, responsibilities, and the company's likely culture (e.g., System Design, Problem Solving, Leadership Principles, Domain Knowledge, or Situational).",
          '- For each phase, provide 4-5 specific question seeds.',
          '- Evaluation: For each phase, provide concrete, measurable "Positive Signals" (what a great answer looks like) and "Red Flags".',
          '',
          '3. Closing',
          '- The interviewer wraps up and invites the candidate to ask questions.',
          '- Include 1-2 question seeds the interviewer can use to close naturally and gauge the candidate\'s strategic curiosity about the company.',
          '',
          'RULES:',
          '- Grounding: Every single question seed must be traceable to a concrete skill, responsibility, or value mentioned in the JD.',
          '- No Cliches: Absolutely no generic questions (e.g., "Where do you see yourself in 5 years?", "What is your biggest weakness?"). Frame them as situational or behavioral challenges related to the JD.',
          '- Realism: Mimic the actual tone and rigor expected at the target company.',
          '',
          'JOB DESCRIPTION:',
          text,
        ].join('\n'),
      });

      await fs.writeFile(cacheFile, JSON.stringify(object, null, 2), 'utf-8');
      console.log(`[DocumentService] Interview structure saved to ${cacheFile}`);
      return {
        structure: object,
        generationTokens: { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 },
      };
    } catch (err) {
      console.error(
        '[DocumentService] Interview structure generation failed:',
        err instanceof Error ? err.message : String(err),
      );
      return { structure: null, generationTokens: null };
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const documentService = new DocumentService();
