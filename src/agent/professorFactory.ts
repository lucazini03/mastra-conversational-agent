// src/agent/professorFactory.ts
//
// WHY A FACTORY instead of a singleton?
// GeminiLiveVoice holds a stateful WebSocket to Google's Live API.
// If you used mastra.getAgent() (singleton), ALL users would share the SAME WebSocket,
// meaning their audio streams would collide. The factory creates a fresh Agent +
// fresh GeminiLiveVoice per WebSocket connection so each user is fully isolated.

import { Agent } from '@mastra/core/agent';
import { GeminiLiveVoice } from '@mastra/voice-google-gemini-live';
import { PROFESSOR_INSTRUCTIONS, VOICE_CONFIG } from '../config/professorConfig.js';

export interface ProfessorAgent {
  agent: Agent;
  voice: GeminiLiveVoice;
  /** Call this when the user disconnects to free the Google Live API session */
  destroy: () => Promise<void>;
}

/**
 * Creates a fully isolated professor agent for one user session.
 * Call once per incoming WebSocket connection; call destroy() on disconnect.
 */
export function createProfessorAgent(): ProfessorAgent {
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error('GOOGLE_API_KEY is required. Copy .env.example to .env and fill it in.');
  }

  const liveModel = (process.env.GEMINI_LIVE_MODEL ?? VOICE_CONFIG.model) as any;

  const voice = new GeminiLiveVoice({
    apiKey,
    model: liveModel,
    speaker: VOICE_CONFIG.speaker,
    sessionConfig: VOICE_CONFIG.sessionConfig,
    // Uncomment to enable verbose Gemini Live API logs:
    // debug: true,
  });

  const agent = new Agent({
    id: 'professor-agent',
    name: 'Il Professore',
    instructions: PROFESSOR_INSTRUCTIONS,
    // The model field here is the TEXT fallback for agent.generate() calls.
    // For real-time voice, GeminiLiveVoice handles everything — this field is
    // largely unused in STS mode but required by the Agent constructor.
    model: `google/gemini-2.0-flash` as any,
    voice,
  });

  const destroy = async () => {
    try {
      await voice.disconnect();
    } catch {
      // Ignore errors during cleanup — connection may already be closed
    }
  };

  return { agent, voice, destroy };
}
