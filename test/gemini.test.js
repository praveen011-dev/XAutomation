import assert from 'node:assert/strict';
import test from 'node:test';

import { GeminiError, generateImage, generateText } from '../src/gemini.js';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fake-image-bytes'),
]);

function response(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => headers[name.toLowerCase()] ?? null,
    },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

const base = 'https://gemini.test/v1beta';

test('generates text and sends the key, system prompt, and config', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({
      candidates: [
        {
          content: {
            parts: [{ text: 'Internal thought', thought: true }, { text: 'Shipped a small fix.' }],
          },
        },
      ],
    });
  };

  const result = await generateText({
    apiKey: 'secret-key',
    model: 'models/gemini-test',
    baseUrl: base,
    system: 'be brief',
    prompt: 'write it',
    fetchImpl,
  });

  assert.equal(result.text, 'Shipped a small fix.');
  assert.equal(result.model, 'gemini-test');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${base}/models/gemini-test:generateContent`);
  assert.equal(calls[0].options.headers['x-goog-api-key'], 'secret-key');
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.systemInstruction.parts[0].text, 'be brief');
  assert.equal(payload.contents[0].parts[0].text, 'write it');
  assert.equal(payload.generationConfig.maxOutputTokens, 400);
});

test('retries 429 and honors Retry-After', async () => {
  const delays = [];
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts === 1) {
      return response({ error: { message: 'slow down' } }, { status: 429, headers: { 'retry-after': '2' } });
    }
    return response({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] });
  };

  const result = await generateText({
    apiKey: 'k',
    model: 'm',
    baseUrl: base,
    prompt: 'p',
    fetchImpl,
    sleepFn: async (ms) => delays.push(ms),
  });

  assert.equal(result.text, 'ok');
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2000]);
});

test('does not retry auth errors and explains the failure', async () => {
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    return response({ error: { message: 'API key not valid' } }, { status: 401 });
  };

  await assert.rejects(
    generateText({ apiKey: 'bad', model: 'm', baseUrl: base, prompt: 'p', fetchImpl }),
    (error) => {
      assert.ok(error instanceof GeminiError);
      assert.match(error.message, /Gemini 401: API key not valid/);
      assert.match(error.message, /GEMINI_API_KEY/);
      return true;
    },
  );
  assert.equal(attempts, 1);
});

test('reports blocked or empty responses', async () => {
  const fetchImpl = async () =>
    response({ promptFeedback: { blockReason: 'SAFETY' }, candidates: [] });

  await assert.rejects(
    generateText({ apiKey: 'k', model: 'm', baseUrl: base, prompt: 'p', fetchImpl }),
    /blocked the prompt \(SAFETY\)/,
  );
});

test('parses the documented /interactions image response', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return response({
      output_image: {
        data: PNG.toString('base64'),
        mime_type: 'image/png',
      },
    });
  };

  const image = await generateImage({
    apiKey: 'k',
    model: 'gemini-nano-banana-2.1',
    baseUrl: base,
    prompt: 'draw it',
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${base}/interactions`);
  const payload = JSON.parse(calls[0].options.body);
  assert.equal(payload.model, 'gemini-nano-banana-2.1');
  assert.equal(payload.input[0].text, 'draw it');
  assert.equal(image.mimeType, 'image/png');
  assert.deepEqual(image.buffer, PNG);
});

test('falls back to generateContent when /interactions is unavailable', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.endsWith('/interactions')) {
      return response({ error: { message: 'not found' } }, { status: 404 });
    }
    return response({
      candidates: [
        {
          content: {
            parts: [{ inlineData: { data: PNG.toString('base64'), mimeType: 'image/png' } }],
          },
        },
      ],
    });
  };

  let fellBack = false;
  const image = await generateImage({
    apiKey: 'k',
    model: 'image-model',
    baseUrl: base,
    prompt: 'draw it',
    fetchImpl,
    onFallback: () => {
      fellBack = true;
    },
  });

  assert.equal(fellBack, true);
  assert.equal(image.buffer.length, PNG.length);
  assert.equal(calls[1], `${base}/models/image-model:generateContent`);
});

test('throws when Gemini returns no image payload', async () => {
  const fetchImpl = async () => response({ output_image: null });
  await assert.rejects(
    generateImage({ apiKey: 'k', model: 'm', baseUrl: base, prompt: 'p', fetchImpl }),
    /returned no image data/,
  );
});
