// app/api/document-config/route.ts
//
// Handles document upload for the serverless architecture.
//
// On upload, saves files to disk at logs/uploads/{uuid}/ and writes a
// config.json alongside them so subsequent API routes (token, rag) can
// find the files without an in-memory store.
//
// POST /api/document-config
//   multipart/form-data fields:
//     summaryDocument: File   (1 file, optional)
//     ragDocuments:    File[] (up to 20 files, optional)
//
// Returns: { documentConfigId, summaryCount, ragCount, effectiveRagCount }

import { NextRequest, NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const UPLOADS_ROOT = path.join(process.cwd(), 'logs', 'uploads');
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB per file
const MAX_FILES = 21; // 1 summary + 20 rag

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function saveFormDataFiles(
  files: File[],
  targetDir: string,
): Promise<string[]> {
  await fs.mkdir(targetDir, { recursive: true });
  const paths: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File "${file.name}" exceeds 25 MB limit.`);
    }
    const safeName = `${String(i + 1).padStart(2, '0')}_${sanitizeName(file.name)}`;
    const dest = path.join(targetDir, safeName);
    const buffer = Buffer.from(await file.arrayBuffer());
    await fs.writeFile(dest, buffer);
    paths.push(dest);
  }

  return paths;
}

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();

    const summaryEntries = formData.getAll('summaryDocument') as File[];
    const ragEntries = formData.getAll('ragDocuments') as File[];

    const summaryFiles = summaryEntries.filter((f): f is File => f instanceof File);
    const ragFiles = ragEntries.filter((f): f is File => f instanceof File);

    if (summaryFiles.length === 0 && ragFiles.length === 0) {
      return NextResponse.json(
        { error: 'At least one summary or RAG document is required.' },
        { status: 400 },
      );
    }

    if (summaryFiles.length + ragFiles.length > MAX_FILES) {
      return NextResponse.json(
        { error: `Too many files. Max ${MAX_FILES} total.` },
        { status: 400 },
      );
    }

    const uploadId = randomUUID();
    const uploadDir = path.join(UPLOADS_ROOT, uploadId);

    const savedSummaryPaths = await saveFormDataFiles(
      summaryFiles,
      path.join(uploadDir, 'summary'),
    );
    const savedRagPaths = await saveFormDataFiles(ragFiles, path.join(uploadDir, 'rag'));

    // The effective RAG set: explicit rag docs, or summary docs if no rag docs.
    const effectiveRagPaths =
      savedRagPaths.length > 0 ? savedRagPaths : [...savedSummaryPaths];

    // Persist config to disk so stateless API routes can resolve paths.
    const config = {
      id: uploadId,
      createdAtMs: Date.now(),
      uploadDir,
      summaryFiles: savedSummaryPaths,
      ragFiles: effectiveRagPaths,
    };
    await fs.writeFile(
      path.join(uploadDir, 'config.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );

    return NextResponse.json({
      documentConfigId: uploadId,
      summaryCount: savedSummaryPaths.length,
      ragCount: savedRagPaths.length,
      effectiveRagCount: effectiveRagPaths.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to store uploaded documents.';
    console.error('[/api/document-config] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
