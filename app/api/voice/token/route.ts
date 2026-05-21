// app/api/voice/token/route.ts
//
// Mints an ephemeral Gemini Live token for client-side use.
//
// Two call modes, detected by the presence of `compactState` in the body:
//
//   Mode A — Initial session:
//     { assistantId, documentConfigId?, resumptionHandle? }
//     → loads base instructions + optional document summary,
//       returns { token, model, hasRagDocuments, initialState? }
//
//   Mode B — Compaction remint:
//     { assistantId, sessionMode, compactState, bufferTurns, documentConfigId? }
//     → assembles new system instruction from compact state + buffer turns,
//       returns { token, model }

import { NextRequest, NextResponse } from 'next/server';
import { GoogleGenAI } from '@google/genai';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  getAssistantInstructions,
  isAssistantId,
  PROFESSOR_RAG_PROMPT,
  PROFESSOR_FREE_ROAM_PROMPT,
  VOICE_CONFIG,
  type AssistantId,
} from '@/src/config/professorConfig';
import { documentService } from '@/src/server/documentService';
import {
  generateMarkdownSummary,
  type AnyAssistantState,
  type SessionMode,
} from '@/src/services/contextManager/index';

// ── Token TTL ────────────────────────────────────────────────────────────────
const TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ── Tool declarations exposed to Gemini Live ─────────────────────────────────
const SEARCH_DOCUMENTS_TOOL = {
  name: 'search_documents',
  description:
    'Search the uploaded study/job documents for relevant information. Use this to ground your answers in the actual document content.',
  parameters: {
    type: 'OBJECT' as const,
    properties: {
      query: {
        type: 'STRING' as const,
        description: 'The search query to find relevant context in the documents.',
      },
    },
    required: ['query'],
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildInitialSystemInstruction(
  assistantId: AssistantId,
  hasRagDocuments: boolean,
  docSummaryText?: string,
): string {
  // For professor, choose RAG or FREE_ROAM based on whether docs are present.
  let base: string;
  if (assistantId === 'professor') {
    base = hasRagDocuments ? PROFESSOR_RAG_PROMPT : PROFESSOR_FREE_ROAM_PROMPT;
  } else {
    base = getAssistantInstructions(assistantId);
  }

  if (!docSummaryText) return base;

  return `${base}\n\n---\n${docSummaryText}`;
}

/**
 * Assembles a "compaction" system instruction from a compact state object
 * and the recent buffer turns (turns that happened during extraction).
 * Mirrors the logic of ContextManager.assembleSystemInstruction().
 */
function assembleCompactionInstruction(
  assistantId: AssistantId,
  sessionMode: SessionMode | undefined,
  baseSystemPrompt: string,
  compactState: AnyAssistantState,
  bufferTurns: Array<{ role: 'user' | 'model'; text: string }>,
): string {
  const sections: string[] = [];

  sections.push(baseSystemPrompt);

  sections.push(
    `\n---\n## ⚠️ SESSION CONTINUATION — READ BEFORE ACTING\n\n` +
      `You are RESUMING an ONGOING conversation that is already in progress. This is NOT a new session.\n\n` +
      `MANDATORY OVERRIDES (these take priority over any phase/flow instructions above):\n` +
      `1. Do NOT re-introduce yourself or greet the user as if meeting for the first time.\n` +
      `2. Do NOT re-execute any opening, onboarding, or introductory phase described in your instructions above.\n` +
      `3. Do NOT call any search or document tool (e.g. search_documents) to retrieve information already present in the Session State below — it was already retrieved earlier in this session.\n` +
      `4. Consult the SESSION STATE below to understand where you are in the conversation and continue seamlessly from that point.\n` +
      `5. Your next action must be a DIRECT CONTINUATION — respond to the user's last message or wait quietly for their input.`,
  );

  if (assistantId === 'professor' && sessionMode) {
    const markdown = generateMarkdownSummary(compactState, sessionMode);
    sections.push(`\n---\n${markdown}`);
  } else {
    sections.push(
      `\n---\n## SESSION STATE (Compact State)\nThe following JSON represents the accumulated state of this conversation so far. Use it to maintain continuity — do NOT ask the user to repeat information already captured here.\n\n\`\`\`json\n${JSON.stringify(compactState, null, 2)}\n\`\`\``,
    );
  }

  if (bufferTurns.length > 0) {
    const turnLines = bufferTurns.map((t, i) => {
      const label = t.role === 'model' ? 'YOU (assistant)' : 'USER';
      return `TURN ${i + 1} — ${label}: "${t.text}"`;
    });

    const lastModelTurn = [...bufferTurns].reverse().find((t) => t.role === 'model');
    const lastMessageBlock = lastModelTurn
      ? `\n════════════════════════════════════════\n` +
        `YOUR LAST MESSAGE (already delivered):\n` +
        `"${lastModelTurn.text}"\n` +
        `════════════════════════════════════════\n`
      : '';

    sections.push(
      `\n---\n## CONVERSATION TRANSCRIPT (Already Spoken — DO NOT REPEAT)\n\n` +
        `The following exchange ALREADY happened. Both you and the user heard it.\n` +
        `This is HISTORY, not new content.\n\n` +
        turnLines.join('\n') +
        lastMessageBlock +
        `\nMANDATORY RULES:\n` +
        `1. You have ALREADY said everything above. NEVER repeat, rephrase, or restate any of it.\n` +
        `2. The user is currently responding or about to respond to your last message. LISTEN and react to their words.\n` +
        `3. Your next response must be a DIRECT CONTINUATION — acknowledge what the user says and move forward naturally.`,
    );
  }

  return sections.join('\n');
}

/** Mint an ephemeral token via @google/genai with system instruction baked in. */
async function mintEphemeralToken(
  systemInstruction: string,
  hasRagDocuments: boolean,
): Promise<string> {
  const apiKey = process.env.GEMINI_LIVE_API_KEY;
  if (!apiKey) throw new Error('GEMINI_LIVE_API_KEY is not configured');

  const model = process.env.GEMINI_LIVE_MODEL ?? VOICE_CONFIG.model;

  const ai = new GoogleGenAI({
    apiKey,
    httpOptions: { apiVersion: 'v1alpha' },
  });

  const functionDeclarations = hasRagDocuments
    ? [SEARCH_DOCUMENTS_TOOL]
    : [];
  const tools = [{ functionDeclarations }];

  const liveConfig: Record<string, unknown> = {
    responseModalities: ['AUDIO'],
    systemInstruction: { parts: [{ text: systemInstruction }] },
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE_CONFIG.speaker } },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    sessionResumption: {},
    // Disable Gemini's built-in VAD — Silero drives turns from the browser.
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: true },
    },
    tools,
  };


  const tokenResponse = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(Date.now() + TOKEN_TTL_MS).toISOString(),
      liveConnectConstraints: {
        model: `models/${model}`,
        config: liveConfig as any,
      },
    },
  });

  if (!tokenResponse.name) {
    throw new Error('Ephemeral token response missing name field');
  }

  return tokenResponse.name;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { assistantId: rawAssistantId = 'professor', documentConfigId, compactState } = body;

    if (!isAssistantId(rawAssistantId)) {
      return NextResponse.json({ error: 'Invalid assistantId' }, { status: 400 });
    }
    const assistantId: AssistantId = rawAssistantId;

    // ── Mode B: Compaction remint ───────────────────────────────────────────
    if (compactState) {
      const {
        sessionMode,
        bufferTurns = [],
        baseSystemPrompt,
      } = body as {
        sessionMode?: SessionMode;
        bufferTurns?: Array<{ role: 'user' | 'model'; text: string }>;
        baseSystemPrompt: string;
      };

      if (!baseSystemPrompt) {
        return NextResponse.json({ error: 'baseSystemPrompt required for remint' }, { status: 400 });
      }

      const newInstruction = assembleCompactionInstruction(
        assistantId,
        sessionMode,
        baseSystemPrompt,
        compactState as AnyAssistantState,
        bufferTurns,
      );

      console.log(
        `[token] Context switch — volatile buffer: ${bufferTurns.length} turns (${JSON.stringify(bufferTurns).length} chars). ` +
        `New system instruction: ${newInstruction.length} chars.`,
      );
      if (bufferTurns.length > 0) {
        console.log(`[token] Volatile buffer turns:\n${bufferTurns.map((t, i) => `  ${i + 1}. [${t.role}]: ${t.text.slice(0, 120)}`).join('\n')}`);
      }

      const hasRagDocuments = Boolean(documentConfigId);
      const token = await mintEphemeralToken(newInstruction, hasRagDocuments);
      const model = process.env.GEMINI_LIVE_MODEL ?? VOICE_CONFIG.model;
      console.log(`[token] Switch complete — new ephemeral token minted. Model: ${model}.`);

      return NextResponse.json({ token, model });
    }

    // ── Mode A: Initial session ─────────────────────────────────────────────

    // Look up uploaded document config if provided
    let summaryFiles: string[] = [];
    let ragFiles: string[] = [];
    let hasRagDocuments = false;

    if (documentConfigId) {
      const configPath = path.join(
        process.cwd(),
        'logs',
        'uploads',
        documentConfigId,
        'config.json',
      );
      try {
        const raw = await fs.readFile(configPath, 'utf-8');
        const cfg = JSON.parse(raw) as {
          summaryFiles: string[];
          ragFiles: string[];
        };
        summaryFiles = cfg.summaryFiles ?? [];
        ragFiles = cfg.ragFiles ?? [];
        hasRagDocuments = ragFiles.length > 0;
      } catch {
        // Config not found — treat as no documents
      }
    }

    // Generate or load document summary for initial instruction enrichment
    let docSummaryText: string | undefined;
    let initialState: AnyAssistantState | undefined;

    if (summaryFiles.length > 0) {
      try {
        const { hash, text } = await documentService.getDocumentsHashAndText(summaryFiles);
        const { index } = await documentService.getOrGenerateSummary(hash, text);

        if (index && assistantId === 'professor') {
          // Build initial topics_to_cover from summary for the professor state
          const { buildInitialProfessorState } = await import(
            '@/src/services/contextManager/initialState'
          );
          const sessionMode: SessionMode = hasRagDocuments ? 'RAG' : 'FREE_ROAM';
          initialState = buildInitialProfessorState(index, sessionMode);
          docSummaryText = formatDocSummaryForInstruction(index, assistantId);
        } else if (index) {
          docSummaryText = formatDocSummaryForInstruction(index, assistantId);
        }
      } catch (err) {
        console.error('[/api/voice/token] Document summary failed:', err);
        // Non-fatal — continue without summary enrichment
      }
    }

    // Warm up the RAG vector index before minting the token.
    // This runs the embedding batch once while the UI shows "Requesting session token...",
    // so the 12-second indexing delay doesn't hit mid-conversation.
    if (hasRagDocuments && ragFiles.length > 0) {
      try {
        const { getSharedBrowserRagService } = await import('@/src/server/ragService');
        const safeSuffix = documentConfigId ? documentConfigId.replace(/-/g, '_') : 'default';
        const ragService = getSharedBrowserRagService({ documentPaths: ragFiles, indexSuffix: safeSuffix });
        console.log('[/api/voice/token] Warming up RAG index...');
        await ragService.ensureReady();
        console.log('[/api/voice/token] RAG index ready.');
      } catch (err) {
        console.error('[/api/voice/token] RAG warm-up failed (non-fatal):', err);
      }
    }

    const systemInstruction = buildInitialSystemInstruction(
      assistantId,
      hasRagDocuments,
      docSummaryText,
    );

    const token = await mintEphemeralToken(systemInstruction, hasRagDocuments);
    const model = process.env.GEMINI_LIVE_MODEL ?? VOICE_CONFIG.model;

    return NextResponse.json({
      token,
      model,
      hasRagDocuments,
      // Return the base prompt so the browser can pass it back during remints.
      baseSystemPrompt: buildInitialSystemInstruction(assistantId, hasRagDocuments),
      ...(initialState ? { initialState } : {}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/voice/token] Error:', message);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDocSummaryForInstruction(
  index: import('@/src/server/documentService').DocumentIndex,
  assistantId: AssistantId,
): string {
  if (assistantId === 'professor' || assistantId === 'study_tutor') {
    const topicLines = index.main_topics
      .map(
        (t) =>
          `- **${t.topic}**${t.subtopics.length > 0 ? ': ' + t.subtopics.join(', ') : ''}`,
      )
      .join('\n');
    return `## DOCUMENT TOPIC MAP\nThe uploaded documents cover the following topics:\n${topicLines}`;
  }

  if (assistantId === 'interview_coach') {
    return `## DOCUMENT CONTEXT\nThe uploaded document covers: ${index.main_topics.map((t) => t.topic).join(', ')}.`;
  }

  return `## DOCUMENT CONTEXT\nTopics covered: ${index.main_topics.map((t) => t.topic).join(', ')}.`;
}
