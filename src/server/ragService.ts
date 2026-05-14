import { createHash } from 'node:crypto';
import path from 'node:path';
import { embed, embedMany } from 'ai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { DuckDBVector } from '@mastra/duckdb';
import { MDocument } from '@mastra/rag';
import { parseDocumentFile } from './documentFileUtils.js';

const DEFAULT_RAG_DB_PATH = path.join(process.cwd(), 'rag.duckdb');
const DEFAULT_RAG_INDEX = 'pdf_knowledge';
const DEFAULT_RAG_QUERY_TOP_K = 5;
const DEFAULT_RAG_MIN_SCORE = 0.1;
const DEFAULT_RAG_CHUNK_MAX_SIZE = 1200;
const DEFAULT_RAG_CHUNK_OVERLAP = 200;
const DEFAULT_RAG_EMBED_BATCH_SIZE = 100;

type RAGConfig = {
  queryTopK: number;
  minScore: number;
  chunkMaxSize: number;
  chunkOverlap: number;
  embedBatchSize: number;
};

function readEnvInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvFloat(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;

  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readEnvPositiveInt(name: string, fallback: number): number {
  const value = readEnvInt(name, fallback);
  return value > 0 ? value : fallback;
}

function readEnvNonNegativeFloat(name: string, fallback: number): number {
  const value = readEnvFloat(name, fallback);
  return value >= 0 ? value : fallback;
}

type RAGInitState = {
  ready: boolean;
  docCount: number;
};

type RagScoredSource = {
  file: string;
  score: number;
  document: string;
  sourceId: string;
};

export class BrowserRagService {
  private readonly documentPaths: string[];
  private readonly indexName: string;
  private readonly vectorStore: DuckDBVector;
  private readonly google: ReturnType<typeof createGoogleGenerativeAI>;
  private readonly config: RAGConfig;
  private embeddingModel: ReturnType<ReturnType<typeof createGoogleGenerativeAI>['textEmbeddingModel']> | null = null;
  //embeddingModel will hold the instance of the embedding model once it's initialized. It starts as null and is set in the ensureEmbeddingToolReady method, which tries to find a compatible embedding model from the Google Generative AI client.
  private initPromise: Promise<RAGInitState> | null = null;

  constructor(options: { documentPaths: string[]; indexSuffix?: string }) {
        const apiKey = process.env.GEMINI_EMBEDDING_API_KEY; // because we are going to use gemini's embedding models
        if (!apiKey) {
          throw new Error('GEMINI_EMBEDDING_API_KEY is required for RAG embeddings.');
        }

        this.documentPaths = [...new Set(options.documentPaths.map((p) => path.resolve(p)))].sort();

        const configuredIndexName = process.env.RAG_INDEX_NAME ?? DEFAULT_RAG_INDEX;
        this.indexName = options.indexSuffix
          ? `${configuredIndexName}_${options.indexSuffix}`
          : configuredIndexName;
        // if RAG_INDEX_NAME is set in the environment, use that, otherwise use the default index name "pdf_knowledge".
        // the index name is used to identify the collection of vectors in the vector store, allowing us to manage multiple collections if needed.

        this.vectorStore = new DuckDBVector({
          id: 'browser-rag-duckdb',
          path: process.env.RAG_DUCKDB_PATH ?? DEFAULT_RAG_DB_PATH,
        });
        // DuckDBVector is a vector store implementation. It will be saved to a file specified by RAG_DUCKDB_PATH or default to "rag.duckdb" in the current working directory.

        this.google = createGoogleGenerativeAI({ apiKey }); // create an instance of the Google Generative AI client using the provided API key. This client will be used to access embedding models for generating vector representations of text.

        this.config = {
          queryTopK: readEnvPositiveInt('RAG_QUERY_TOP_K', DEFAULT_RAG_QUERY_TOP_K),
          minScore: readEnvNonNegativeFloat('RAG_MIN_SCORE', DEFAULT_RAG_MIN_SCORE),
          chunkMaxSize: readEnvPositiveInt('RAG_CHUNK_MAX_SIZE', DEFAULT_RAG_CHUNK_MAX_SIZE),
          chunkOverlap: readEnvPositiveInt('RAG_CHUNK_OVERLAP', DEFAULT_RAG_CHUNK_OVERLAP),
          embedBatchSize: readEnvPositiveInt('RAG_EMBED_BATCH_SIZE', DEFAULT_RAG_EMBED_BATCH_SIZE),
        };
  }

  async ensureReady(): Promise<RAGInitState> { //Promise<RAGInitState> means this function returns a promise that resolves to an object belonging to the RAGInitState type, which has a boolean "ready" property and a number "docCount" property.
    if (!this.initPromise) {
      this.initPromise = this.buildIndex().catch((err) => {
        this.initPromise = null;
        throw err;
      });
    }
    return this.initPromise;
  }
  //overall, ensureReady is a method that initializes the RAG system by building the vector index from PDF documents. It ensures that the initialization process is only triggered once and returns the state of readiness and the count of indexed documents.

  async queryRelevantContext(queryText: string, topK?: number):
                    Promise<{ relevantContext: string; sources: string[]; scoredSources: RagScoredSource[] }> {
    //topK represents the maximum number of relevant chunks to retrieve based on cosine similarity
    // the function then returns an object containing the combined relevant context as a string, an array of source file names, and an array of scored sources with their respective scores and document text. The function first checks if the RAG system is ready and if the embedding model is available. If not, it logs a warning and returns empty results. If everything is ready, it generates an embedding for the query text, retrieves relevant chunks from the vector store based on cosine similarity, filters them by a minimum score threshold, ensures uniqueness by chunk, and constructs the relevant context and source information to return.

    // if either the RAG system is not ready or the embedding model is not available, it returns an empty context and no sources. Otherwise, it generates an embedding for the query text, retrieves relevant chunks from the vector store based on cosine similarity, filters and sorts them by score, and returns the combined relevant context along with source information and scored sources.
    const state = await this.ensureReady();
    if (!state.ready) {
      console.warn('[RAG] RAG system is not ready. Cannot perform query.');
      return { relevantContext: '', sources: [], scoredSources: [] };
    }
    const embeddingModel = this.embeddingModel;
    if (!embeddingModel) {
      console.warn('[RAG] Embedding model is not ready. Cannot perform query.');
      return { relevantContext: '', sources: [], scoredSources: [] };
    }

    const effectiveTopK = topK ?? this.config.queryTopK;
    const minScore = this.config.minScore; // minimum cosine similarity score to consider a chunk relevant.
    const t0 = performance.now(); // start a timer to measure how long the query process takes, which can be useful for performance monitoring and debugging.
    const { embedding: queryEmbedding } = await embed({ // generate an embedding for the query text using the initialized embedding model. This vector representation of the query will be used to compare against the vectors of the document chunks in the vector store to find relevant context.
      model: embeddingModel,
      value: queryText,
    });
    console.log(`[RAG] Generated embedding for query in ${(performance.now() - t0).toFixed(2)} ms.`); // log the time taken to generate the embedding for the query, which can help in understanding the performance of the embedding process and in identifying any potential bottlenecks.

    const t1 = performance.now();
    const rawResults = await this.vectorStore.query({
      indexName: this.indexName, // specify which index to query against, allowing for organized management of multiple vector collections if needed.
      queryVector: queryEmbedding,
      topK: effectiveTopK,
    });
    console.log(`[RAG] Retrieved raw results from vector store in ${(performance.now() - t1).toFixed(2)} ms.`); // log the time taken to retrieve results from the vector store, which can help in understanding the performance of the retrieval process and in identifying any potential bottlenecks.

    const scoredSources: RagScoredSource[] = rawResults
      .map((r: any) => {
        const meta = r?.metadata ?? {};
        const file = typeof meta?.sourceFile === 'string' ? meta.sourceFile : 'unknown';
        const score = typeof r?.score === 'number' ? r.score : 0;
        const sourceId = typeof meta?.sourceId === 'string' ? meta.sourceId : `${file}:unknown`;
        const document =
          typeof meta?.text === 'string'
            ? meta.text
            : typeof meta?.chunkText === 'string'
              ? meta.chunkText
              : '';
        return { file, score, document, sourceId };
      }) // this map function transforms the raw results from the vector store query into a structured format defined by the RagScoredSource type, extracting the file name, cosine similarity score, document text, and source ID from the metadata of each result.
      .sort((a: RagScoredSource, b: RagScoredSource) => b.score - a.score); // lambda function to sort the scored sources in descending order based on their cosine similarity

    // log the top-k scores for debugging purposes, showing the file name and score for each of the top results. This can help in understanding which documents are being considered most relevant to the query and in tuning the retrieval process if needed.
    if (scoredSources.length > 0) {
      const debugScores = scoredSources
        .slice(0, effectiveTopK)
        .map((s, i) => `#${i + 1} ${s.file} (${s.score.toFixed(3)})`)
        .join(' | ');
      console.log(`[RAG] top-k scores for "${queryText}": ${debugScores}`);
    }
    
    // thresholded is a filtered list of scored sources that only includes those with a cosine similarity score above the specified minimum threshold. This helps to ensure that only sufficiently relevant chunks are included in the final context, improving the quality of the retrieved information for the query.
    const thresholded = scoredSources.filter((s) => s.score >= minScore);
    // uniqueByChunk is a filtered list of scored sources that ensures only one chunk per source document is included, based on the sourceId. This prevents multiple chunks from the same document from dominating the relevant context, allowing for a more diverse set of sources to be represented in the retrieved context.
    // CAN BE MODIFIED: if you want to allow multiple chunks from the same document, you could remove the uniqueness filter and instead just take the top-k scored sources directly. This would allow for more context from a single document to be included if it has multiple relevant chunks, but it might also lead to less diversity in the sources of the retrieved context.
    const uniqueByChunk = thresholded.filter((item, idx, all) => all.findIndex((x) => x.sourceId === item.sourceId) === idx);
    const sources = [...new Set(uniqueByChunk.map((s) => s.file))]; // extract the unique set of source file names from the filtered scored sources, which can be useful for providing attribution or for debugging purposes to see which documents are contributing to the relevant context.
    const relevantContext = uniqueByChunk
      .map((s) => s.document.trim())
      .filter((text) => text.length > 0)
      .join('\n\n---\n\n');
    // we simply create a string of the relevant context by concatenating the document text of the unique scored sources, separated by a delimiter (in this case, "\n\n---\n\n") to clearly distinguish between different chunks of context. This combined string can then be used as input for further processing, such as providing context to a language model for answering a question or generating a response based on the retrieved information.

    return { relevantContext, sources, scoredSources: uniqueByChunk };
  }

  private async buildIndex(): Promise<RAGInitState> {
    // this function is responsible for building the vector index from the PDF documents. It first ensures that the embedding tool is ready, then it reads all PDF files from the specified directory, extracts and normalizes their text content, chunks the text into manageable pieces, generates embeddings for each chunk, and finally upserts these embeddings into the vector store. The function returns an object indicating whether the RAG system is ready and how many unique source documents were indexed.
    await this.ensureEmbeddingToolReady();

    const embeddingModel = this.embeddingModel;
    if (!embeddingModel) {
      throw new Error('RAG embedding model is not initialized.');
    }

    if (this.documentPaths.length === 0) {
      console.log('[RAG] No documents selected for RAG. RAG disabled.');
      return { ready: false, docCount: 0 };
    }

    // Skip re-embedding if the index already exists and has vectors in DuckDB.
    // The indexName encodes the document set via indexSuffix (derived from documentConfigId),
    // so a pre-existing populated index is always valid for the same document set.
    try {
      const existingIndexes = await this.vectorStore.listIndexes();
      if (existingIndexes.includes(this.indexName)) {
        const stats = await this.vectorStore.describeIndex({ indexName: this.indexName });
        if (stats.count > 0) {
          console.log(`[RAG] Reusing existing index "${this.indexName}" (${stats.count} vectors, ${this.documentPaths.length} doc(s)).`);
          return { ready: true, docCount: this.documentPaths.length };
        }
      }
    } catch {
      // If the check fails for any reason, fall through and rebuild.
    }

    const chunks: Array<{ text: string; metadata: Record<string, unknown> }> = [];

    for (const filePath of this.documentPaths) {
      const fileName = path.basename(filePath);
      try {
        const parsed = await parseDocumentFile(filePath);
        const normalizedText = parsed?.normalizedText ?? '';

        if (!normalizedText) continue;

        const doc = MDocument.fromText(normalizedText, { //doc will be the entire text of the PDF, which will then be chunked
          sourceFile: fileName,
          sourceType: 'pdf',
        });

        const docChunks = await doc.chunk({
          strategy: 'recursive', // recursive means it will try to split by paragraphs, then sentences, then words, to create chunks that are as large as possible without exceeding the maxSize
          maxSize: this.config.chunkMaxSize, 
          overlap: this.config.chunkOverlap,
        });

        docChunks.forEach((chunk, idx) => {
          const text = chunk.text?.trim();
          if (!text) return;

          const hash = createHash('sha1').update(`${fileName}:${idx}:${text}`).digest('hex');
          chunks.push({
            text,
            metadata: {
              sourceFile: fileName,
              sourceType: 'pdf',
              chunkIndex: idx,
              sourceId: `${fileName}:${idx}`,
              chunkHash: hash,
              text,
              chunkText: text,
            },
          });
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[RAG] Failed to ingest ${fileName}: ${msg}`);
      }
    }

    if (chunks.length === 0) {
      console.warn('[RAG] Documents were selected, but no readable text was extracted.');
      return { ready: false, docCount: 0 };
    }

    const texts = chunks.map((c) => c.text);
    // Google Vertex AI limits batch requests to 100 items max.
    // Split texts into batches and embed each batch separately.
    const embeddings: number[][] = [];

    for (let i = 0; i < texts.length; i += this.config.embedBatchSize) {
      const batch = texts.slice(i, i + this.config.embedBatchSize);
      console.log(`[RAG] Embedding batch ${Math.floor(i / this.config.embedBatchSize) + 1}/${Math.ceil(texts.length / this.config.embedBatchSize)} (${batch.length} items)...`);
      const { embeddings: batchEmbeddings } = await embedMany({
        model: embeddingModel,
        values: batch,
      });
      embeddings.push(...batchEmbeddings);
    }

    const dimension = embeddings[0]?.length;
    if (!dimension) {
      throw new Error('RAG embedding dimension could not be determined.');
    }

    try {
      await this.vectorStore.deleteIndex({ indexName: this.indexName });
    } catch {
      // Ignore if index does not exist yet.
    }

    await this.vectorStore.createIndex({
      indexName: this.indexName,
      dimension,
      metric: 'cosine',
    });

    await this.vectorStore.upsert({
      indexName: this.indexName,
      vectors: embeddings,
      metadata: chunks.map((c) => c.metadata),
      ids: chunks.map((c) => c.metadata.sourceId as string),
    });

    const sourceFileCount = new Set(chunks.map((c) => String(c.metadata.sourceFile))).size;
    console.log(`[RAG] Indexed ${chunks.length} chunks from ${sourceFileCount} document files.`);

    return { ready: true, docCount: sourceFileCount };
  }

  private async ensureEmbeddingToolReady() {
    if (this.embeddingModel) return;

    const envModel = process.env.RAG_EMBEDDING_MODEL?.trim();
    const candidates = [envModel, 'gemini-embedding-001', 'gemini-embedding-2-preview']
      .filter((m): m is string => Boolean(m));

    let lastError: unknown = null;

    for (const candidate of candidates) {
      try {
        const model = this.google.textEmbeddingModel(candidate);

        // Probe with a tiny embedding call so unsupported models fail early.
        await embedMany({ model, values: ['healthcheck'] });

        this.embeddingModel = model;

        console.log(`[RAG] Using embedding model: ${candidate}`);
        return;
      } catch (err) {
        lastError = err;
      }
    }

    const details = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `No supported RAG embedding model found. Tried: ${candidates.join(', ')}. Last error: ${details}`,
    );
  }
}

// ── Singleton factory ──────────────────────────────────────────────────────────
//
// Serverless routes call this to get (or create) a shared BrowserRagService
// instance for a given set of document paths + index suffix.  Caching is
// keyed by the sorted documentPaths + indexSuffix so different document
// configurations get isolated instances while repeated calls for the same
// configuration share one instance and its already-built index.

const sharedInstances = new Map<string, BrowserRagService>();

export function getSharedBrowserRagService(options: {
  documentPaths: string[];
  indexSuffix?: string;
}): BrowserRagService {
  const key = JSON.stringify({
    paths: [...options.documentPaths].sort(),
    suffix: options.indexSuffix ?? '',
  });
  let instance = sharedInstances.get(key);
  if (!instance) {
    instance = new BrowserRagService(options);
    sharedInstances.set(key, instance);
  }
  return instance;
}
