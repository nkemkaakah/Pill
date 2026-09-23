'use strict';
/**
 * Decides which provider answers a question, and resolves that decision into real
 * request credentials. Both functions are pure — no I/O, no Electron — so they are
 * fully unit-testable the same way lib/align.js is.
 *
 * The rule: DeepSeek (via OpenRouter) only ever answers a question with no screenshot
 * attached, and only when a key is configured. DeepSeek's standard chat model is
 * text-only — an attached image either errors or is silently dropped depending on the
 * model — so a screenshot is a hard disqualifier, not a preference. Quick actions that
 * need vision (e.g. "solve what's on screen") already carry a screenshot via the same
 * `wantsShot` flag main.js computes per request, so they fall out of this rule for
 * free rather than needing a special case.
 */

/**
 * @param {object} o
 * @param {boolean} o.hasScreenshot  the `wantsShot` flag for this request — whether a
 *   screenshot is meant to ride along, not whether capture happened to succeed.
 * @param {boolean} o.hasDeepseekKey
 * @returns {'deepseek'|'primary'}
 */
function chooseRoute({ hasScreenshot, hasDeepseekKey }) {
  return (!hasScreenshot && hasDeepseekKey) ? 'deepseek' : 'primary';
}

/**
 * Resolves a route into {provider, baseUrl, apiKey, model}. `provider` is the string
 * lib/provider.js's chat() dispatcher expects ('anthropic' or 'openai') — DeepSeek and
 * OpenRouter speak the OpenAI-compatible shape, so the 'deepseek' route still comes
 * back as provider: 'openai' with different credentials, not a new code path.
 * @param {'deepseek'|'primary'} route
 * @param {object} cfg  the app config, or a plain object with the same field names
 * @param {boolean} smart
 */
function credentialsFor(route, cfg, smart) {
  if (route === 'deepseek') {
    return {
      provider: 'openai',
      baseUrl: cfg.deepseekBaseUrl,
      apiKey: cfg.deepseekApiKey,
      model: smart ? cfg.deepseekSmartModel : cfg.deepseekFastModel,
    };
  }
  if (cfg.provider === 'gemini') {
    // Gemini speaks the OpenAI-compatible shape; provider stays 'gemini' so
    // provider.js can apply its few differences (token field, thinking, errors).
    return {
      provider: 'gemini',
      baseUrl: cfg.geminiBaseUrl,
      apiKey: cfg.geminiApiKey,
      model: smart ? cfg.geminiSmartModel : cfg.geminiFastModel,
    };
  }
  const anthropic = cfg.provider === 'anthropic';
  return {
    provider: cfg.provider,
    baseUrl: anthropic ? cfg.anthropicBaseUrl : cfg.baseUrl,
    apiKey: anthropic ? cfg.anthropicApiKey : cfg.apiKey,
    model: anthropic
      ? (smart ? cfg.anthropicSmartModel : cfg.anthropicFastModel)
      : (smart ? cfg.smartModel : cfg.fastModel),
  };
}

module.exports = { chooseRoute, credentialsFor };
