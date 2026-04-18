// src/server/documentService.ts
//
// Singleton service responsible for:
//   1. Reading PDF files from rag-docs/, extracting and normalising text.
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
import { PDFParse } from 'pdf-parse';
import { z } from 'zod';

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

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_DOCS_DIR = path.join(process.cwd(), 'rag-docs');
const SUMMARIES_DIR = path.join(process.cwd(), 'logs', 'summaries');

// ── Service ───────────────────────────────────────────────────────────────────

class DocumentService {
  private googleClient: ReturnType<typeof createGoogleGenerativeAI> | null = null;

  /** In-memory cache — cleared on process restart (i.e. per deploy). */
  private cachedContent: DocsContent | null = null;

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

  /**
   * Reads every PDF from rag-docs/, extracts normalised text via pdf-parse,
   * and returns a stable hash + combined text + per-file breakdown.
   *
   * Results are cached in memory for the process lifetime so repeated calls
   * (from ragService & sessionHandler) incur no I/O cost.
   */
  async getDocumentsHashAndText(): Promise<DocsContent> {
    if (this.cachedContent) return this.cachedContent;

    const docsDir = process.env.RAG_DOCS_DIR
      ? path.resolve(process.env.RAG_DOCS_DIR)
      : DEFAULT_DOCS_DIR;

    await fs.mkdir(docsDir, { recursive: true });

    const entries = await fs.readdir(docsDir, { withFileTypes: true });

    // Sort for a stable hash regardless of filesystem ordering.
    const pdfPaths = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
      .map((e) => path.join(docsDir, e.name))
      .sort();

    if (pdfPaths.length === 0) {
      const empty: DocsContent = { hash: 'no-docs', text: '', files: [] };
      this.cachedContent = empty;
      return empty;
    }

    const files: Array<{ name: string; normalizedText: string }> = [];

    for (const filePath of pdfPaths) {
      const name = path.basename(filePath);
      try {
        const raw = await fs.readFile(filePath);
        const parser = new PDFParse({ data: raw });
        let parsed;
        try {
          parsed = await parser.getText();
        } finally {
          await parser.destroy();
        }
        const normalizedText = parsed.text.replace(/\s+/g, ' ').trim();
        if (normalizedText) {
          files.push({ name, normalizedText });
        }
      } catch (err) {
        console.warn(
          `[DocumentService] Failed to parse ${name}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    const combinedText = files.map((f) => f.normalizedText).join('\n\n');
    const hash = createHash('sha256').update(combinedText).digest('hex');

    this.cachedContent = { hash, text: combinedText, files };
    console.log(
      `[DocumentService] Loaded ${files.length} PDF(s), hash ${hash.slice(0, 12)}...`,
    );
    return this.cachedContent;
  }

  /**
   * Returns a cached DocumentIndex summary for the given document hash.
   * On a cache miss, generates one via Gemini and persists it to
   * logs/summaries/<hash>_summary.json so subsequent startups are instant.
   *
   * Returns null if no documents are loaded or generation fails.
   */
  async getOrGenerateSummary(hash: string, fullText: string): Promise<DocumentIndex | null> {
    if (!fullText || hash === 'no-docs') return null;

    await fs.mkdir(SUMMARIES_DIR, { recursive: true });
    const cacheFile = path.join(SUMMARIES_DIR, `${hash}_summary.json`);

    // ── Cache hit ─────────────────────────────────────────────────────────
    try {
      const raw = await fs.readFile(cacheFile, 'utf-8');
      const parsed = DocumentIndexSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        console.log(`[DocumentService] Summary cache hit (hash ${hash.slice(0, 12)}...)`);
        return parsed.data;
      }
    } catch {
      // File absent or corrupt — fall through to generation.
    }

    // ── Cache miss: generate via Gemini ───────────────────────────────────
    console.log(`[DocumentService] Generating summary (hash ${hash.slice(0, 12)}...)...`);
    try {
      const google = this.getGoogleClient();
      const model = google('gemini-3.1-flash-lite-preview');

      const { object } = await generateObject({
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
      return object;
    } catch (err) {
      console.error(
        '[DocumentService] Summary generation failed:',
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  }
}

// ── Singleton export ──────────────────────────────────────────────────────────

export const documentService = new DocumentService();
