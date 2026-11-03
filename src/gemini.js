import { X_MEDIA_LIMIT_BYTES } from './config.js';
import { sleep } from './util.js';

export class GeminiError extends Error {
  constructor(message, { status, retryable = false, body, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'GeminiError';
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

function normalizeModelId(model) {
  return String(model ?? '').replace(/^models\//, '');
}

function apiMessage(body) {
  if (!body) return '';
  if (typeof body === 'string') return body.slice(0, 300);
  return (
    body.error?.message ||
    body.error?.status ||
    body.message ||
    body.promptFeedback?.blockReason ||
    ''
  );
}

function withHint(message, status) {
  if (status === 401 || status === 403) {
    return `${message}\nCheck GEMINI_API_KEY and that the Generative Language API is enabled for the key.`;
  }
  if (status === 404) {
    return `${message}\nCheck GEMINI_MODEL / GEMINI_IMAGE_MODEL and GEMINI_BASE_URL.`;
  }
  if (status === 429) {
    return `${message}\nGemini rate limit or free-tier quota reached. Try again in a minute.`;
  }
  return message;
}

function retryDelayMs(response, attempt) {
  const header = response?.headers?.get?.('retry-after');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds)) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(header);
    if (Number.isFinite(date)) return Math.max(0, Math.min(date - Date.now(), 30_000));
  }
  return Math.min(800 * 2 ** (attempt - 1), 8_000);
}

async function requestJson({
  url,
  apiKey,
  payload,
  fetchImpl = fetch,
  timeoutMs = 60_000,
  maxAttempts = 3,
  sleepFn = sleep,
  onRetry,
}) {
  let lastError = new GeminiError('Gemini request failed');

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      lastError = new GeminiError(`Could not reach Gemini: ${error.message}`, { cause: error });
      if (attempt === maxAttempts) throw lastError;
      const delayMs = retryDelayMs(null, attempt);
      onRetry?.({ attempt, delayMs, message: lastError.message });
      await sleepFn(delayMs);
      continue;
    }

    const raw = await response.text();
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        body = raw;
      }
    }

    if (response.ok) {
      if (body && typeof body === 'object' && body.error) {
        throw new GeminiError(withHint(apiMessage(body) || 'Gemini returned an error', body.error.code), {
          status: body.error.code,
          body,
        });
      }
      return body;
    }

    const status = response.status;
    const retryable = status === 408 || status === 429 || status >= 500;
    const message = `Gemini ${status}${apiMessage(body) ? `: ${apiMessage(body)}` : ''}`;
    lastError = new GeminiError(withHint(message, status), { status, retryable, body });

    if (!retryable || attempt === maxAttempts) throw lastError;

    const delayMs = retryDelayMs(response, attempt);
    onRetry?.({ attempt, delayMs, message, status });
    await sleepFn(delayMs);
  }

  throw lastError;
}

export async function generateText({
  apiKey,
  model,
  baseUrl,
  system = '',
  prompt,
  fetchImpl = fetch,
  timeoutMs = 60_000,
  maxAttempts = 3,
  sleepFn = sleep,
  maxOutputTokens = 400,
  temperature = 0.9,
  onRetry,
} = {}) {
  const modelId = normalizeModelId(model);
  const endpoint = `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`;

  const payload = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature,
      topP: 0.95,
      maxOutputTokens,
    },
  };
  if (system) payload.systemInstruction = { parts: [{ text: system }] };

  const body = await requestJson({
    url: endpoint,
    apiKey,
    payload,
    fetchImpl,
    timeoutMs,
    maxAttempts,
    sleepFn,
    onRetry,
  });

  const parts = body?.candidates?.[0]?.content?.parts ?? [];
  const text = parts
    .filter((part) => part && part.thought !== true)
    .map((part) => part.text ?? '')
    .join('')
    .trim();

  if (!text) {
    const blockReason = body?.promptFeedback?.blockReason;
    const finishReason = body?.candidates?.[0]?.finishReason;
    throw new GeminiError(
      blockReason
        ? `Gemini blocked the prompt (${blockReason}).`
        : `Gemini returned no text${finishReason ? ` (finishReason: ${finishReason})` : ''}.`,
      { body },
    );
  }

  return { text, model: modelId, raw: body };
}

function sniffMimeType(buffer) {
  if (!buffer || buffer.length < 4) return null;
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return 'image/png';
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'image/webp';
  }
  return null;
}

function extractImagePayload(body) {
  const candidates = [];
  const seen = new Set();
  const push = (value) => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    candidates.push(value);
  };

  push(body?.output_image);
  push(body?.outputImage);
  push(body?.interaction?.output_image);
  push(body?.output?.image);

  for (const key of ['output', 'outputs']) {
    if (Array.isArray(body?.[key])) {
      for (const item of body[key]) push(item?.image ?? item);
    }
  }

  for (const part of body?.candidates?.[0]?.content?.parts ?? []) {
    const inline = part?.inlineData ?? part?.inline_data;
    if (inline) push({ data: inline.data, mimeType: inline.mimeType ?? inline.mime_type });
  }

  push(body?.predictions?.[0]);
  push(body?.generatedImages?.[0]?.image);

  for (const candidate of candidates) {
    const data =
      candidate.data ??
      candidate.base64 ??
      candidate.image_bytes ??
      candidate.bytesBase64Encoded;
    if (typeof data === 'string' && data.length > 0) {
      return {
        base64: data,
        mimeType:
          candidate.mimeType ??
          candidate.mime_type ??
          candidate.mime ??
          candidate.mimeTypeString,
      };
    }
  }

  return null;
}

function decodeImage(payload) {
  let base64 = payload.base64;
  let declaredMime = payload.mimeType;

  const dataUrl = base64.match(/^data:([^;]+);base64,(.*)$/s);
  if (dataUrl) {
    declaredMime = declaredMime || dataUrl[1];
    base64 = dataUrl[2];
  }

  base64 = base64.replace(/\s+/g, '');
  const buffer = Buffer.from(base64, 'base64');
  if (!buffer.length) {
    throw new GeminiError('Gemini returned image data that could not be decoded.');
  }
  if (buffer.length > X_MEDIA_LIMIT_BYTES) {
    throw new GeminiError(
      `Generated image is ${(buffer.length / (1024 * 1024)).toFixed(2)} MB; X allows at most 5 MB per image.`,
    );
  }

  const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
  // Trust the bytes over the declared type so the saved extension matches.
  let mimeType = sniffMimeType(buffer) ?? String(declaredMime ?? '').toLowerCase();
  if (!allowed.includes(mimeType)) mimeType = 'image/png';

  return { buffer, mimeType };
}

/**
 * Generate one image. Tries the documented /interactions endpoint first and
 * falls back to generateContent for keys/projects where /interactions is not
 * available yet.
 */
export async function generateImage({
  apiKey,
  model,
  baseUrl,
  prompt,
  fetchImpl = fetch,
  timeoutMs = 90_000,
  maxAttempts = 3,
  sleepFn = sleep,
  onRetry,
  onFallback,
} = {}) {
  const modelId = normalizeModelId(model);
  const requestOptions = {
    apiKey,
    fetchImpl,
    timeoutMs,
    maxAttempts,
    sleepFn,
    onRetry,
  };

  let body;
  try {
    body = await requestJson({
      ...requestOptions,
      url: `${baseUrl}/interactions`,
      payload: {
        model: modelId,
        input: [{ type: 'text', text: prompt }],
      },
    });
  } catch (error) {
    const endpointUnavailable =
      error instanceof GeminiError && (error.status === 404 || error.status === 405);
    if (!endpointUnavailable) throw error;

    onFallback?.(error);
    body = await requestJson({
      ...requestOptions,
      url: `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`,
      payload: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseModalities: ['IMAGE'] },
      },
    });
  }

  const payload = extractImagePayload(body);
  if (!payload) {
    throw new GeminiError(
      'Gemini returned no image data. The configured image model may not support image output.',
      { body },
    );
  }

  const { buffer, mimeType } = decodeImage(payload);
  return { buffer, mimeType, model: modelId };
}
