'use strict';
// The one context document (userData/context.md) — background material about the
// user that gets folded into every question and every notes generation. Same
// one-module-one-concern shape as sessions.js and speakers.js.
//
// Only the extracted plain text is kept; the original upload (PDF, whatever) is never
// stored. Small metadata (filename, char count, upload date) lives in config.json
// alongside the other settings — this module only owns the content file itself.

const fs = require('fs');
const path = require('path');

// Deliberately uncached: it's one cheap string join, and caching it globally on first
// call broke test isolation (a second fake `app` in the same process silently reused
// the first one's path). Production only ever has one real `app`, so this costs nothing.
function contextPath(app) {
  return path.join(app.getPath('userData'), 'context.md');
}

function readText(app) {
  try {
    return fs.readFileSync(contextPath(app), 'utf8');
  } catch (_) {
    return '';
  }
}

function writeText(app, text) {
  const p = contextPath(app);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return text.length;
}

function remove(app) {
  try {
    fs.unlinkSync(contextPath(app));
  } catch (_) {
    /* already gone */
  }
}

/**
 * Extracts plain text from an uploaded file. .txt/.md are read directly; .pdf goes
 * through pdf-parse. pdf-parse is required lazily so a missing/broken install only
 * breaks PDF uploads, not the module itself.
 */
async function extractText(sourcePath) {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.txt' || ext === '.md') {
    return fs.readFileSync(sourcePath, 'utf8');
  }
  if (ext === '.pdf') {
    let PDFParse;
    try {
      ({ PDFParse } = require('pdf-parse'));
    } catch (_) {
      throw new Error('PDF support needs the pdf-parse package. Run npm install and try again.');
    }
    const data = fs.readFileSync(sourcePath);
    const parser = new PDFParse({ data });
    try {
      const result = await parser.getText();
      const raw = result && result.text ? result.text : '';
      // pdf-parse v2 inserts a "-- N of M --" footer between pages (confirmed against
      // the installed 2.4.5 output); strip it so it doesn't leak into the model's
      // context as if it were part of the document.
      return raw.replace(/--\s*\d+\s*of\s*\d+\s*--/g, '');
    } finally {
      if (typeof parser.destroy === 'function') await parser.destroy();
    }
  }
  throw new Error(`Unsupported file type "${ext || '(none)'}" — use .txt, .md, or .pdf.`);
}

/**
 * Ingest an uploaded file as the one context document: extract, normalize whitespace,
 * save it, and hand back the metadata the caller should persist to config.
 */
async function ingest(app, sourcePath) {
  const raw = await extractText(sourcePath);
  const text = raw
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) throw new Error('No text could be extracted from that file.');
  const chars = writeText(app, text);
  return {
    chars,
    words: text.split(/\s+/).filter(Boolean).length,
    filename: path.basename(sourcePath),
    uploadedAt: Date.now(),
  };
}

module.exports = { contextPath, readText, writeText, remove, extractText, ingest };
