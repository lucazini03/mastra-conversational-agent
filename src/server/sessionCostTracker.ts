type TokenBreakdown = {
  inputText: number;
  inputAudio: number;
  outputText: number;
  outputAudio: number;
};

type SessionPricing = {
  textInputPer1M: number;
  textOutputPer1M: number;
  audioInputPer1M: number;
  audioOutputPer1M: number;
};

type UsageEventPoint = {
  index: number;
  deltaInput: number;
  deltaOutput: number;
  cumulativeInput: number;
  cumulativeOutput: number;
};

type PricingResolution = {
  pricing: SessionPricing;
  configured: boolean;
};

export type SessionCostSummary = {
  inputTokens: number;
  outputTokens: number;
  ragTokens: number;
  inputTextTokens: number;
  inputAudioTokens: number;
  outputTextTokens: number;
  outputAudioTokens: number;
  inputCostUsd: number | null;
  outputCostUsd: number | null;
  ragCostUsd: number | null;
  estimatedCostUsd: number | null;
  pricingConfigured: boolean;
  usageEvents: number;
  ragCalls: number;
  growth: {
    shape: 'insufficient_data' | 'linear_like' | 'quadratic_like' | 'sublinear_like';
    firstDeltaInput: number;
    lastDeltaInput: number;
    avgDeltaInput: number;
    deltaSlopePerTurn: number;
  };
};

function readPriceEnv(value: string | undefined): number | null {
  if (!value || value.trim().length === 0) return null;
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

function resolvePricing(): PricingResolution {
  const textInput = readPriceEnv(process.env.GOOGLE_PRICE_TEXT_INPUT_PER_1M);
  const textOutput = readPriceEnv(process.env.GOOGLE_PRICE_TEXT_OUTPUT_PER_1M);
  const audioInput = readPriceEnv(process.env.GOOGLE_PRICE_AUDIO_INPUT_PER_1M);
  const audioOutput = readPriceEnv(process.env.GOOGLE_PRICE_AUDIO_OUTPUT_PER_1M);

  const configured =
    textInput !== null &&
    textOutput !== null &&
    audioInput !== null &&
    audioOutput !== null;

  return {
    configured,
    pricing: {
      textInputPer1M: textInput ?? 0,
      textOutputPer1M: textOutput ?? 0,
      audioInputPer1M: audioInput ?? 0,
      audioOutputPer1M: audioOutput ?? 0,
    },
  };
}

const PRICING = resolvePricing();

export class SessionCostTracker {
  private usageTotals: TokenBreakdown = {
    inputText: 0,
    inputAudio: 0,
    outputText: 0,
    outputAudio: 0,
  };
  private usageEventsSeen = 0;
  private ragCalls = 0;
  private ragEstimatedTokens = 0;
  private sessionStartedAtMs = Date.now();
  private usageHistory: UsageEventPoint[] = [];

  reset() {
    this.usageTotals = { inputText: 0, inputAudio: 0, outputText: 0, outputAudio: 0 };
    this.usageEventsSeen = 0;
    this.ragCalls = 0;
    this.ragEstimatedTokens = 0;
    this.sessionStartedAtMs = Date.now();
    this.usageHistory = [];
  }

  captureUsageMetadata(payload: unknown) {
    const visited = new Set<object>();
    const usageObjects: unknown[] = [];

    const walk = (value: unknown) => {
      if (!value || typeof value !== 'object') return;
      const asObj = value as Record<string, unknown>;
      if (visited.has(asObj)) return;
      visited.add(asObj);

      const usage = asObj.usageMetadata ?? asObj.usage_metadata;
      if (usage && typeof usage === 'object') {
        usageObjects.push(usage);
      }

      Object.values(asObj).forEach((inner) => {
        if (inner && typeof inner === 'object') walk(inner);
      });
    };

    walk(payload);

    for (const usage of usageObjects) {
      const parsed = this.parseUsageObject(usage);
      if (!parsed) continue;

      const deltaInput = parsed.inputText + parsed.inputAudio;
      const deltaOutput = parsed.outputText + parsed.outputAudio;

      this.usageTotals.inputText += parsed.inputText;
      this.usageTotals.inputAudio += parsed.inputAudio;
      this.usageTotals.outputText += parsed.outputText;
      this.usageTotals.outputAudio += parsed.outputAudio;
      this.usageEventsSeen += 1;
      this.usageHistory.push({
        index: this.usageEventsSeen,
        deltaInput,
        deltaOutput,
        cumulativeInput: this.usageTotals.inputText + this.usageTotals.inputAudio,
        cumulativeOutput: this.usageTotals.outputText + this.usageTotals.outputAudio,
      });
    }
  }

  recordRagUsage(toolResult: { result: string; sources: string[]; scores: Array<{ file: string; score: number }> }) {
    this.ragCalls += 1;
    const payload = JSON.stringify(toolResult);
    const estimatedTokens = Math.max(1, Math.ceil(payload.length / 4));
    this.ragEstimatedTokens += estimatedTokens;
  }

  getSummary(): { summary: SessionCostSummary; sessionMinutes: number; pricing: SessionPricing } {
    const inputTokens = this.usageTotals.inputText + this.usageTotals.inputAudio;
    const outputTokens = this.usageTotals.outputText + this.usageTotals.outputAudio;
    const ragTokens = this.ragEstimatedTokens;
    const growth = this.summarizeGrowth();

    const inputCostUsd = PRICING.configured
      ? (this.usageTotals.inputText / 1_000_000) * PRICING.pricing.textInputPer1M +
        (this.usageTotals.inputAudio / 1_000_000) * PRICING.pricing.audioInputPer1M
      : null;

    const outputCostUsd = PRICING.configured
      ? (this.usageTotals.outputText / 1_000_000) * PRICING.pricing.textOutputPer1M +
        (this.usageTotals.outputAudio / 1_000_000) * PRICING.pricing.audioOutputPer1M
      : null;

    const ragCostUsd = PRICING.configured
      ? (ragTokens / 1_000_000) * PRICING.pricing.textInputPer1M
      : null;

    const estimatedCostUsd = inputCostUsd !== null && outputCostUsd !== null
      ? inputCostUsd + outputCostUsd
      : null;

    const summary: SessionCostSummary = {
      inputTokens,
      outputTokens,
      ragTokens,
      inputTextTokens: this.usageTotals.inputText,
      inputAudioTokens: this.usageTotals.inputAudio,
      outputTextTokens: this.usageTotals.outputText,
      outputAudioTokens: this.usageTotals.outputAudio,
      inputCostUsd,
      outputCostUsd,
      ragCostUsd,
      estimatedCostUsd,
      pricingConfigured: PRICING.configured,
      usageEvents: this.usageEventsSeen,
      ragCalls: this.ragCalls,
      growth,
    };

    const sessionMinutes = (Date.now() - this.sessionStartedAtMs) / 60_000;
    return { summary, sessionMinutes, pricing: PRICING.pricing };
  }

  private summarizeGrowth() {
    if (this.usageHistory.length < 3) {
      return {
        shape: 'insufficient_data' as const,
        firstDeltaInput: this.usageHistory[0]?.deltaInput ?? 0,
        lastDeltaInput: this.usageHistory[this.usageHistory.length - 1]?.deltaInput ?? 0,
        avgDeltaInput: this.usageHistory.length === 0
          ? 0
          : this.usageHistory.reduce((acc, p) => acc + p.deltaInput, 0) / this.usageHistory.length,
        deltaSlopePerTurn: 0,
      };
    }

    const first = this.usageHistory[0].deltaInput;
    const last = this.usageHistory[this.usageHistory.length - 1].deltaInput;
    const avg = this.usageHistory.reduce((acc, p) => acc + p.deltaInput, 0) / this.usageHistory.length;
    const slope = (last - first) / Math.max(1, this.usageHistory.length - 1);

    let shape: 'linear_like' | 'quadratic_like' | 'sublinear_like' = 'linear_like';
    if (last > first * 1.6 && slope > 0) {
      shape = 'quadratic_like';
    } else if (last < first * 0.75 && slope < 0) {
      shape = 'sublinear_like';
    }

    return {
      shape,
      firstDeltaInput: first,
      lastDeltaInput: last,
      avgDeltaInput: avg,
      deltaSlopePerTurn: slope,
    };
  }

  private parseUsageObject(usage: unknown): TokenBreakdown | null {
    if (!usage || typeof usage !== 'object') return null;

    const obj = usage as Record<string, unknown>;

    const promptCount = this.readNumber(
      obj.promptTokenCount,
      obj.prompt_token_count,
      obj.inputTokenCount,
      obj.input_token_count,
    );

    const candidateCount = this.readNumber(
      obj.candidatesTokenCount,
      obj.candidates_token_count,
      obj.responseTokenCount,
      obj.response_token_count,
      obj.completionTokenCount,
      obj.completion_token_count,
      obj.outputTokenCount,
      obj.output_token_count,
    );

    const totalCount = this.readNumber(
      obj.totalTokenCount,
      obj.total_token_count,
    );

    const promptDetails = this.extractModalityCounts(
      obj.promptTokensDetails,
      obj.prompt_tokens_details,
      obj.inputTokenDetails,
      obj.input_token_details,
    );

    const candidateDetails = this.extractModalityCounts(
      obj.candidatesTokensDetails,
      obj.candidates_tokens_details,
      obj.outputTokenDetails,
      obj.output_token_details,
    );

    let inputAudio = promptDetails.audio;
    let inputText = promptDetails.text;
    let outputAudio = candidateDetails.audio;
    let outputText = candidateDetails.text;

    if (promptCount > 0 && inputAudio + inputText === 0) {
      inputText = promptCount;
    }

    const effectiveCandidateCount =
      candidateCount > 0
        ? candidateCount
        : totalCount > 0 && promptCount > 0
          ? Math.max(0, totalCount - promptCount)
          : 0;

    if (effectiveCandidateCount > 0 && outputAudio + outputText === 0) {
      outputText = effectiveCandidateCount;
    }

    if (inputAudio + inputText + outputAudio + outputText === 0) {
      return null;
    }

    return { inputText, inputAudio, outputText, outputAudio };
  }

  private readNumber(...values: unknown[]): number {
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        return Math.max(0, Math.trunc(value));
      }
      if (typeof value === 'string' && value.trim().length > 0) {
        const parsed = Number.parseFloat(value);
        if (Number.isFinite(parsed)) {
          return Math.max(0, Math.trunc(parsed));
        }
      }
    }
    return 0;
  }

  private extractModalityCounts(...detailCandidates: unknown[]): { text: number; audio: number } {
    const result = { text: 0, audio: 0 };

    for (const details of detailCandidates) {
      if (!Array.isArray(details)) continue;

      for (const item of details) {
        if (!item || typeof item !== 'object') continue;
        const row = item as Record<string, unknown>;
        const modalityRaw = String(
          row.modality ?? row.modality_type ?? row.tokenType ?? row.token_type ?? '',
        ).toLowerCase();
        const count = this.readNumber(row.tokenCount, row.token_count, row.count);
        if (count <= 0) continue;

        if (modalityRaw.includes('audio')) {
          result.audio += count;
        } else {
          result.text += count;
        }
      }
    }

    return result;
  }
}
