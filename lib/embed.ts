// Thin wrapper around Gemini's embedContent REST API. We hit the REST
// endpoint directly rather than via @google/generative-ai because that
// SDK doesn't expose `outputDimensionality`, and gemini-embedding-001
// defaults to 3072 dims — we need 768 to match the vector column.
//
// The API key is sent via the `x-goog-api-key` header rather than the
// `?key=` query param so it never lands in URL-aware logs.

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;
export const EMBED_BATCH_SIZE = 100;

const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents`;

/**
 * Task type tells the embedding model what the text will be used for.
 * Documents being indexed use RETRIEVAL_DOCUMENT; queries being run
 * against the index use RETRIEVAL_QUERY. Mixing the two degrades recall.
 */
export type EmbedTaskType = "RETRIEVAL_DOCUMENT" | "RETRIEVAL_QUERY";

export type EmbedOptions = {
  taskType?: EmbedTaskType;
};

export class EmbedError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "EmbedError";
    this.status = status;
  }
}

/**
 * Embed an arbitrary number of texts via Gemini, splitting into
 * batches of EMBED_BATCH_SIZE under the hood. Returns one vector per
 * input, in the same order.
 */
export async function embedBatch(
  texts: string[],
  apiKey: string,
  options: EmbedOptions = {},
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!apiKey) throw new EmbedError(401, "missing API key");

  const taskType: EmbedTaskType = options.taskType ?? "RETRIEVAL_DOCUMENT";
  const results: number[][] = [];

  for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
    const slice = texts.slice(offset, offset + EMBED_BATCH_SIZE);
    const startedAt = Date.now();
    const vectors = await embedOnce(slice, apiKey, taskType);
    const elapsedMs = Date.now() - startedAt;
    console.log(
      `embed batch model=${EMBEDDING_MODEL} task=${taskType} offset=${offset} size=${slice.length} elapsed_ms=${elapsedMs}`,
    );
    if (vectors.length !== slice.length) {
      throw new EmbedError(
        502,
        `Gemini returned ${vectors.length} embeddings for ${slice.length} inputs`,
      );
    }
    for (const v of vectors) results.push(v);
  }

  return results;
}

type BatchResponse = {
  embeddings?: Array<{ values?: number[] }>;
  error?: { message?: string };
};

async function embedOnce(
  texts: string[],
  apiKey: string,
  taskType: EmbedTaskType,
): Promise<number[][]> {
  const body = {
    requests: texts.map((text) => ({
      model: `models/${EMBEDDING_MODEL}`,
      content: { parts: [{ text }] },
      taskType,
      outputDimensionality: EMBEDDING_DIMENSIONS,
    })),
  };

  const resp = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-goog-api-key": apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    let detail = "";
    try {
      const text = await resp.text();
      detail = text.slice(0, 500);
    } catch {
      detail = resp.statusText;
    }
    // Defense in depth: scrub the key in case it slipped into the
    // upstream error payload somehow.
    detail = detail.split(apiKey).join("[redacted]");
    throw new EmbedError(resp.status, `Gemini embedding error: ${detail}`);
  }

  const json = (await resp.json()) as BatchResponse;
  if (!json.embeddings) {
    throw new EmbedError(502, "Gemini response missing embeddings");
  }
  return json.embeddings.map((e, i) => {
    if (!e.values || e.values.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbedError(
        502,
        `Gemini embedding ${i} has unexpected shape (len=${e.values?.length})`,
      );
    }
    return e.values;
  });
}
