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
  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
  };
  if (opts.maxTokens) body.max_completion_tokens = opts.maxTokens;
  if (opts.reasoningEffort && opts.reasoningEffort !== 'none' && supportsReasoningEffort(opts.model)) {
    body.reasoning_effort = opts.reasoningEffort;
  }

  const headers = { 'Content-Type': 'application/json' };
  if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;

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

/**
 * Transcribe a short audio clip (webm/opus from MediaRecorder).
 * @returns {Promise<string>} text ('' when nothing intelligible)
 */
async function transcribe({ baseUrl, apiKey, model, audio, mime = 'audio/webm', prompt, language, signal }) {
  const url = `${trimSlash(baseUrl)}/audio/transcriptions`;
  const form = new FormData();
  form.append('file', new Blob([audio], { type: mime }), 'chunk.webm');
  form.append('model', model);
  form.append('response_format', 'text');
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);

  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, { method: 'POST', headers, body: form, signal });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(describeHttpError(res.status, text, { baseUrl, model }));
  }
  const text = (await res.text()).trim();
  return text;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch (_) {
    return '';
  }
}

function describeHttpError(status, body, opts) {
  let msg = '';
  try {
    msg = JSON.parse(body)?.error?.message || '';
  } catch (_) {
    msg = body.slice(0, 300);
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
  if (system) body.system = system;
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
 * Provider dispatcher. `provider` is 'anthropic' or 'openai' (any OpenAI-compatible endpoint).
 */
function chat(provider, opts) {
  return provider === 'anthropic' ? streamAnthropic(opts) : streamChat(opts);
}

module.exports = { chat, streamChat, streamAnthropic, transcribe, supportsReasoningEffort, supportsAnthropicEffort, toAnthropicContent };
