import { promises as fs } from 'node:fs';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import { parse as parseHtml } from 'node-html-parser';
import JSZip from 'jszip';
import rtfParser, { RtfNode } from 'rtf-parser';

export type ParsedDocument = {
  name: string;
  normalizedText: string;
};

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);

function extractRtfText(doc: RtfNode): string {
  let text = '';
  if (doc.value) text += doc.value;
  if (doc.content) {
    for (const child of doc.content) {
      text += extractRtfText(child);
    }
  }
  return text;
}

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

  if (extension === '.docx') {
    const raw = await fs.readFile(absolutePath);
    const result = await mammoth.extractRawText({ buffer: raw });
    const normalizedText = result.value.replace(/\s+/g, ' ').trim();
    if (!normalizedText) return null;
    return { name, normalizedText };
  }

  if (extension === '.odt') {
    const raw = await fs.readFile(absolutePath);
    const zip = await JSZip.loadAsync(raw);
    const contentXml = await zip.file('content.xml')?.async('text');
    if (!contentXml) return null;
    const text = contentXml
      .replace(/<text:line-break[^>]*\/>/g, ' ')
      .replace(/<\/text:p>/g, ' ')
      .replace(/<[^>]+>/g, '');
    const normalizedText = text.replace(/\s+/g, ' ').trim();
    if (!normalizedText) return null;
    return { name, normalizedText };
  }

  if (extension === '.rtf') {
    const raw = await fs.readFile(absolutePath, 'utf-8');
    const normalizedText = await new Promise<string>((resolve, reject) => {
      rtfParser.string(raw, (err: Error | null, doc: RtfNode) => {
        if (err) return reject(err);
        resolve(extractRtfText(doc).replace(/\s+/g, ' ').trim());
      });
    });
    if (!normalizedText) return null;
    return { name, normalizedText };
  }

  if (extension === '.html' || extension === '.htm') {
    const raw = await fs.readFile(absolutePath, 'utf-8');
    const root = parseHtml(raw);
    const normalizedText = root.text.replace(/\s+/g, ' ').trim();
    if (!normalizedText) return null;
    return { name, normalizedText };
  }

  if (TEXT_EXTENSIONS.has(extension)) {
    const raw = await fs.readFile(absolutePath, 'utf-8');
    const normalizedText = raw.replace(/\s+/g, ' ').trim();
    if (!normalizedText) return null;
    return { name, normalizedText };
  }

  return null;
}
