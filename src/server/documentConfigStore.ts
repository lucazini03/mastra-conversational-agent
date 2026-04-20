import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';

export type UploadedDocumentConfig = {
  id: string;
  createdAtMs: number;
  uploadDir: string;
  summaryFiles: string[];
  ragFiles: string[];
};

type UploadConfigPayload = Omit<UploadedDocumentConfig, 'id' | 'createdAtMs'>;

export class DocumentConfigStore {
  private readonly ttlMs: number;
  private readonly configs = new Map<string, UploadedDocumentConfig>();

  constructor(ttlMs = 30 * 60 * 1000) {
    this.ttlMs = ttlMs;
  }

  async create(payload: UploadConfigPayload): Promise<UploadedDocumentConfig> {
    await this.pruneExpired();

    const id = randomUUID();
    const config: UploadedDocumentConfig = {
      id,
      createdAtMs: Date.now(),
      uploadDir: payload.uploadDir,
      summaryFiles: payload.summaryFiles,
      ragFiles: payload.ragFiles,
    };
    this.configs.set(id, config);
    return config;
  }

  async consume(id: string): Promise<UploadedDocumentConfig | null> {
    await this.pruneExpired();
    const config = this.configs.get(id);
    if (!config) return null;
    this.configs.delete(id);
    return config;
  }

  private async pruneExpired(): Promise<void> {
    const now = Date.now();
    const expired: UploadedDocumentConfig[] = [];

    for (const config of this.configs.values()) {
      if (now - config.createdAtMs > this.ttlMs) {
        expired.push(config);
      }
    }

    for (const config of expired) {
      this.configs.delete(config.id);
      try {
        await fs.rm(config.uploadDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
  }
}
