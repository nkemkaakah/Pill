'use strict';
// Talks to any OpenAI-compatible /chat/completions endpoint with streaming,
// and to OpenAI's /audio/transcriptions for speech-to-text.
// Plain fetch on purpose: no SDK version drift, easy to read, easy to swap.

function trimSlash(u) {
  return String(u || '').replace(/\/+$/, '');
}

function isLocal(baseUrl) {
  return /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);
}

// Models that accept reasoning_effort on chat completions. Sending it to a model that
// doesn't understand it returns a 400, so we only include it for known families.
function supportsReasoningEffort(model) {
  return /^(gpt-5|o[1-9])/i.test(model || '');
}

/**
 * Stream a chat completion.
 * @param {object} opts
 * @param {string} opts.baseUrl
 * @param {string} opts.apiKey
 * @param {string} opts.model
 * @param {Array}  opts.messages   OpenAI-format messages (content may be string or parts array)
 * @param {string} [opts.reasoningEffort]
 * @param {number} [opts.maxTokens]
 * @param {AbortSignal} [opts.signal]
 * @param {(text:string)=>void} opts.onDelta
 * @returns {Promise<string>} full text
 */
async function streamChat(opts) {
  const url = `${trimSlash(opts.baseUrl)}/chat/completions`;
  const gemini = opts.gemini || isGemini(opts.baseUrl);
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (gemini) {
    // Gemini documents max_tokens, not max_completion_tokens, and counts its thinking
    // tokens against the same limit — too low a cap returns an empty answer that is
    // still billed. Floor it so a small setting can't starve the reply.
    if (opts.maxTokens) body.max_tokens = Math.max(opts.maxTokens, GEMINI_MIN_TOKENS);
    // Gemini maps low/medium/high to its thinking levels. 'none' is only valid on 2.5
    // Flash models, so leave it out and let the model use its default.
    if (['low', 'medium', 'high'].includes(opts.reasoningEffort)) body.reasoning_effort = opts.reasoningEffort;
  } else {
    if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;
    if (opts.reasoningEffort && opts.reasoningEffort !== 'none' && supportsReasoningEffort(opts.model)) {
      body.reasoning_effort = opts.reasoningEffort;
    }
  }

  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
  // Optional attribution for OpenRouter's public app rankings — a nicety, not
  // required for auth; omitting it changes nothing about the request itself.
  if (/openrouter\.ai/i.test(opts.baseUrl || '')) headers['X-Title'] = 'Nola';

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(describeHttpError(res.status, text, opts));
  }

  // Ollama and some proxies may answer non-streamed JSON even when asked to stream.
  const ctype = res.headers.get('content-type') || '';
  if (!ctype.includes('text/event-stream') && ctype.includes('application/json')) {
    const json = await res.json();
    const text = json?.choices?.[0]?.message?.content || '';
    if (text) opts.onDelta(text);
    return text;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') return full;
      let json;
      try {
        json = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      const delta = json?.choices?.[0]?.delta?.content;
      if (delta) {
        full += delta;
        opts.onDelta(delta);
      }
      if (json?.error) throw new Error(json.error.message || 'provider error');
    }
  }
  return full;
}

// `transcribe()` used to live here: a multipart POST to OpenAI's
// /audio/transcriptions, one request per 6-second clip. It returned a bare string, so
// it could express neither interim results nor word timings. Transcription is now
// local and streaming — see lib/sidecar.js StreamingSidecar.

async function safeText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

const GEMINI_MIN_TOKENS = 8192;

function isGemini(baseUrl) {
  return /generativelanguage\.googleapis\.com/i.test(baseUrl || '');
}

function describeHttpError(status, body, opts) {
  let msg = '';
  try {
    const j = JSON.parse(body);
    // Gemini wraps errors in an array: [{"error":{...}}].
    msg = (Array.isArray(j) ? j[0] : j)?.error?.message || '';
  } catch (_) {
    msg = body.slice(0, 300);
  }
  // Gemini rejects a bad or missing key with 400 INVALID_ARGUMENT, not 401.
  if (status === 400 && isGemini(opts.baseUrl) && /api key|authorization header/i.test(msg)) {
    return `Google rejected the Gemini API key. Open settings and paste a valid key from aistudio.google.com/apikey. (${msg})`;
  }
  if (status === 401) return 'Your API key was rejected (401). Open settings and paste a valid key.';
  if (status === 403) return `The key is not allowed to use ${opts.model} (403). ${msg}`.trim();
  if (status === 404 && isLocal(opts.baseUrl)) {
    return `Model "${opts.model}" not found on ${opts.baseUrl}. Pull it first (e.g. ollama pull ${opts.model}).`;
  }
  if (status === 404) return `Model "${opts.model}" not found (404). Change the model in settings. ${msg}`.trim();
  if (status === 429) return `Rate limited or out of credits (429). ${msg}`.trim();
  return `Provider error ${status}: ${msg || 'no details'}`;
}

// ---------------------------------------------------------------------------
// Anthropic Messages API (native). Docs: platform.claude.com/docs/en/api/messages
// ---------------------------------------------------------------------------

// Models that accept output_config.effort. Haiku 4.5 and the 4.5 generation do not.
function supportsAnthropicEffort(model) {
  return /(opus-4-[5-9]|opus-5|sonnet-4-6|sonnet-5|fable|mythos)/i.test(model || '');
}

// Minimum tokens Anthropic needs in a prefix before it will actually cache it. Below
// the line, a cache_control marker is a silent no-op — no error, cache_creation
// reads back 0, billed as ordinary input — so this exists only to decide whether
// attaching the marker can possibly do anything, not to avoid an error.
// Source: Anthropic prompt-caching docs, checked 2026-09; not monotonic across
// generations, which is why this is a table and not a single constant.
const CACHE_MINIMUMS = [
  { re: /(opus-5|fable-5|mythos-5)/i, min: 512 },
  { re: /(opus-4-8|sonnet-5|sonnet-4-6|sonnet-4-5|opus-4-1|^opus-4$|sonnet-4)/i, min: 1024 },
  { re: /(opus-4-7|mythos-preview|haiku-3-5)/i, min: 2048 },
  { re: /(opus-4-6|opus-4-5|haiku-4-5)/i, min: 4096 },
];
function anthropicCacheMinimum(model) {
  const hit = CACHE_MINIMUMS.find((row) => row.re.test(model || ''));
  return hit ? hit.min : 4096; // unknown model: assume the strictest known floor
}

// Rough chars-per-token estimate for the cache-eligibility check only — never used for
// billing or truncation, just to decide whether the marker is worth attaching.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

// Convert OpenAI-style message content (string, or parts with text / image_url data URLs)
// into Anthropic content blocks.
function toAnthropicContent(content) {
  if (typeof content === 'string') return content;
  const blocks = [];
  for (const part of content) {
    if (part.type === 'text' && part.text) {
      blocks.push({ type: 'text', text: part.text });
    } else if (part.type === 'image_url' && part.image_url?.url) {
      const m = /^data:(image\/[a-z]+);base64,(.+)$/i.exec(part.image_url.url);
      if (m) blocks.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
    }
  }
  return blocks;
}

/**
 * Stream a Claude response. Same call shape as streamChat: `messages` may include a
 * leading system message, which is lifted into Anthropic's top-level `system`.
 */
async function streamAnthropic(opts) {
  const url = `${trimSlash(opts.baseUrl || 'https://api.anthropic.com')}/v1/messages`;
  const system = opts.messages.filter((m) => m.role === 'system').map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join('\n'))).join('\n\n');
  const messages = opts.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role, content: toAnthropicContent(m.content) }));

  const body = {
    model: opts.model,
    max_tokens: opts.maxTokens || 4096,
    messages,
    stream: true,
  };
  if (system) {
    // Below the model's cache minimum, stay byte-identical to the old plain-string
    // shape — no behavior change, no risk. At or above it, wrap in the array form so
    // the marker can actually do something. See CACHE_MINIMUMS above for why this is
    // model-dependent rather than a single threshold.
    body.system = estimateTokens(system) >= anthropicCacheMinimum(opts.model)
      ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
      : system;
  }
  const effort = opts.reasoningEffort === 'none' ? 'low' : opts.reasoningEffort;
  if (effort && supportsAnthropicEffort(opts.model)) body.output_config = { effort };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': opts.apiKey || '',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(describeAnthropicError(res.status, text, opts));
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      let ev;
      try {
        ev = JSON.parse(line.slice(5).trim());
      } catch (_) {
        continue;
      }
      if (ev.type === 'message_start' && process.env.PILL_DEBUG_CACHE) {
        const u = ev.message?.usage;
        if (u) console.error(`[cache] model=${opts.model} input=${u.input_tokens} cache_read=${u.cache_read_input_tokens || 0} cache_write=${u.cache_creation_input_tokens || 0}`);
      }
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
        full += ev.delta.text;
        opts.onDelta(ev.delta.text);
      } else if (ev.type === 'error') {
        throw new Error(ev.error?.message || 'Anthropic stream error');
      } else if (ev.type === 'message_stop') {
        return full;
      }
    }
  }
  return full;
}

function describeAnthropicError(status, body, opts) {
  let msg = '';
  try {
    msg = JSON.parse(body)?.error?.message || '';
  } catch (_) {
    msg = body.slice(0, 300);
  }
  if (status === 401) return 'Anthropic rejected the API key (401). Open settings and paste a valid key.';
  if (status === 403) return `This key is not allowed to use ${opts.model} (403). ${msg}`.trim();
  if (status === 404) return `Model "${opts.model}" not found on Anthropic (404). Change the model in settings. ${msg}`.trim();
  if (status === 429) return `Rate limited or out of credits (429). ${msg}`.trim();
  if (status === 529) return 'Anthropic is overloaded right now (529). Try again in a moment.';
  return `Anthropic error ${status}: ${msg || 'no details'}`;
}

/**
 * Provider dispatcher. `provider` is 'anthropic', 'gemini', or 'openai' (any
 * OpenAI-compatible endpoint). Gemini goes through the same OpenAI-compatible code.
 */
function chat(provider, opts) {
  if (provider === 'anthropic') return streamAnthropic(opts);
  return streamChat({ ...opts, gemini: provider === 'gemini' });
}

module.exports = { chat, streamChat, streamAnthropic, supportsReasoningEffort, supportsAnthropicEffort, toAnthropicContent, describeHttpError, isGemini };
