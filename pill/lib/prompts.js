'use strict';

const BASE_SYSTEM = `You are Pill, a private assistant floating over the user's screen. You can be given a screenshot of what they are looking at and a rolling transcript of audio around them ("me" = the user speaking, "them" = other people / whatever is playing on the machine).

Ground rules:
- Answer the actual question first, in the first sentence. No preamble, no restating the question.
- Be tight. The panel is small. Prefer short paragraphs and bullets over long prose.
- For coding questions: give working code in a fenced block with the language tag, then at most a few lines on the key idea, edge cases, and complexity when it matters. Don't explain syntax.
- If a screenshot is attached, treat what's on screen as the primary context. Read the exact text on it (question, error, code) before answering. Only describe the screenshot if asked.
- If the transcript is attached and the request is about the conversation, answer the most recent question asked by "them", or say what "me" should say next, in natural spoken language the user can read aloud.
- If something is unreadable or missing, say what you need in one line rather than guessing.
- Use Markdown. Use fenced code blocks for anything the user might copy.`;

const QUICK_ACTIONS = {
  answer: {
    label: 'Answer what was just asked',
    prompt:
      'Look at the transcript. Find the most recent question or prompt from "them" and answer it directly, in a form I can say out loud. If the screenshot shows a question instead, answer that.',
    wantsScreenshot: true,
    wantsTranscript: true,
  },
  solve: {
    label: 'Solve what is on screen',
    prompt:
      'Solve the problem shown on the screenshot. If it is a coding problem: restate the task in one line, give the full solution in a code block, then complexity. If it is a question or a bug, answer/fix it directly.',
    wantsScreenshot: true,
    wantsTranscript: false,
  },
  say: {
    label: 'What should I say?',
    prompt:
      'Based on the transcript, tell me what to say next. Give one short, natural spoken answer (2 to 5 sentences) I can read aloud, then optionally two bullet points I could add if pressed.',
    wantsScreenshot: false,
    wantsTranscript: true,
  },
  recap: {
    label: 'Recap the conversation',
    prompt:
      'Summarise the transcript so far: key points, decisions, open questions, and anything I committed to. Bullets, tight.',
    wantsScreenshot: false,
    wantsTranscript: true,
  },
};

function buildSystem(userSystemPrompt) {
  return userSystemPrompt && userSystemPrompt.trim()
    ? `${BASE_SYSTEM}\n\nAdditional instructions from the user:\n${userSystemPrompt.trim()}`
    : BASE_SYSTEM;
}

/**
 * @param {Array<{t:number, who:'me'|'them', text:string}>} entries
 * @param {number} windowMinutes
 */
function formatTranscript(entries, windowMinutes) {
  const cutoff = Date.now() - windowMinutes * 60_000;
  const recent = entries.filter((e) => e.t >= cutoff);
  if (!recent.length) return '';
  const lines = recent.map((e) => {
    const stamp = new Date(e.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `[${stamp}] ${e.who}: ${e.text}`;
  });
  return `Transcript of the last ${windowMinutes} minutes (most recent last):\n${lines.join('\n')}`;
}

/**
 * Build the user message content parts.
 */
function buildUserContent({ question, screenshotDataUrl, transcriptText }) {
  const parts = [];
  if (transcriptText) parts.push({ type: 'text', text: transcriptText });
  if (screenshotDataUrl) {
    parts.push({ type: 'text', text: 'Screenshot of my screen right now:' });
    parts.push({ type: 'image_url', image_url: { url: screenshotDataUrl, detail: 'high' } });
  }
  parts.push({ type: 'text', text: question });
  return parts;
}

// Older turns lose their images so history stays cheap; the text is kept.
function stripImages(messages) {
  return messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const kept = m.content.filter((p) => p.type === 'text' && p.text !== 'Screenshot of my screen right now:');
    const hadImage = kept.length !== m.content.length;
    if (hadImage) kept.push({ type: 'text', text: '(a screenshot was attached here)' });
    return { ...m, content: kept };
  });
}

module.exports = { BASE_SYSTEM, QUICK_ACTIONS, buildSystem, formatTranscript, buildUserContent, stripImages };
