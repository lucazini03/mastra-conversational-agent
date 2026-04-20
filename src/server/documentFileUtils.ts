import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';

export type ParsedDocument = {
  name: string;
  normalizedText: string;
};

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);

export async function parseDocumentFile(filePath: string): Promise<ParsedDocument | null> {
  const absolutePath = path.resolve(filePath);
  const extension = path.extname(absolutePath).toLowerCase();
  const name = path.basename(absolutePath);

  if (extension === '.pdf') {
    const raw = await fs.readFile(absolutePath);
    const parser = new PDFParse({ data: raw });
    try {
      const parsed = await parser.getText();
      const normalizedText = parsed.text.replace(/\s+/g, ' ').trim();
      if (!normalizedText) return null;
      return { name, normalizedText };
    } finally {
      await parser.destroy();
    }
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    const raw = await fs.readFile(absolutePath, 'utf-8');
    const normalizedText = raw.replace(/\s+/g, ' ').trim();
    if (!normalizedText) return null;
    return { name, normalizedText };
  }

  return null;
}
