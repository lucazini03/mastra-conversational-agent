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
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const documentService = new DocumentService();
