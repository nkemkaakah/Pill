'use strict';
// Every recording is a session. The live transcript is appended to disk line by
// line as it arrives, so nothing is lost if the app dies. After recording stops
// the local engine can replace the whole file with a refined, speaker-labelled
// transcript (applyFinal). Notes are saved next to it as Markdown.
//
//   <userData>/sessions/2026-09-03_14-05.jsonl      {"type":"meta",...} then one {"type":"entry",...} per line
//   <userData>/sessions/2026-09-03_14-05.notes.md   generated notes (optional)
//   <userData>/sessions/2026-09-03_14-05.me.wav     raw mic audio (optional)
//   <userData>/sessions/2026-09-03_14-05.them.wav   raw system audio (optional)
//
// Entry fields: { t, who: 'me'|'them', text, key?, name? }
//   key  = stable speaker key within the session ('me', 'S0', 'S1', ...)
//   name = display name at write time ('me', 'Gareth', 'Speaker 1', ...)
// Meta fields: { id, startedAt, title, refined?, speakers?: [{key,name,uid,seconds,embedding}] }

const fs = require('fs');
const path = require('path');

let dir = null;

function init(app) {
  dir = path.join(app.getPath('userData'), 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function folder() {
  return dir;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function newId(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
}

const fileFor = (id) => path.join(dir, `${id}.jsonl`);
const notesFileFor = (id) => path.join(dir, `${id}.notes.md`);
const audioFileFor = (id, who) => path.join(dir, `${id}.${who}.wav`);

function create(title) {
  let id = newId();
  let n = 2;
  while (fs.existsSync(fileFor(id))) id = `${newId()}-${n++}`;
  const meta = { type: 'meta', id, startedAt: Date.now(), title: title || '' };
  fs.writeFileSync(fileFor(id), `${JSON.stringify(meta)}\n`);
  return { id, startedAt: meta.startedAt, title: meta.title };
}

function append(id, entry) {
  try {
    fs.appendFileSync(fileFor(id), `${JSON.stringify({ type: 'entry', ...entry })}\n`);
  } catch (err) {
    console.error('[pill] transcript append failed:', err.message);
  }
}

function writeAll(id, meta, entries) {
  const lines = [JSON.stringify({ type: 'meta', ...meta, id })];
  for (const e of entries) lines.push(JSON.stringify({ type: 'entry', ...e }));
  fs.writeFileSync(fileFor(id), `${lines.join('\n')}\n`);
}

function load(id) {
  let raw;
  try {
    raw = fs.readFileSync(fileFor(id), 'utf8');
  } catch (_) {
    return null;
  }
  const out = { id, startedAt: 0, title: '', refined: false, speakers: [], entries: [], notes: '' };
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let j;
    try {
      j = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (j.type === 'meta') {
      out.startedAt = j.startedAt;
      out.title = j.title || '';
      out.refined = Boolean(j.refined);
      out.speakers = Array.isArray(j.speakers) ? j.speakers : [];
    } else if (j.type === 'entry') {
      const e = { t: j.t, who: j.who, text: j.text };
      if (j.key) e.key = j.key;
      if (j.name) e.name = j.name;
      out.entries.push(e);
    }
  }
  try {
    out.notes = fs.readFileSync(notesFileFor(id), 'utf8');
  } catch (_) {
    out.notes = '';
  }
  return out;
}

function meta(s) {
  return { startedAt: s.startedAt, title: s.title, refined: s.refined, speakers: s.speakers };
}

function setTitle(id, title) {
  const s = load(id);
  if (!s) return;
  s.title = title;
  writeAll(id, meta(s), s.entries);
}

/**
 * Replace the live transcript with the refined, speaker-labelled one.
 * @param utterances [{key, name, start, end, text}] seconds relative to session start
 * @param speakers   [{key, name, uid, seconds, embedding}]
 */
function applyFinal(id, utterances, speakers) {
  const s = load(id);
  if (!s) return null;
  const entries = utterances.map((u) => ({
    t: s.startedAt + Math.round(u.start * 1000),
    who: u.key === 'me' ? 'me' : 'them',
    text: u.text,
    key: u.key,
    name: u.name,
  }));
  writeAll(id, { ...meta(s), refined: true, speakers }, entries);
  return load(id);
}

/**
 * Rename a speaker everywhere in one session (meta + every entry).
 * Roster updates happen in main.js; this only rewrites the session file.
 */
function renameSpeaker(id, key, name, uid) {
  const s = load(id);
  if (!s) return null;
  for (const sp of s.speakers) {
    if (sp.key === key) {
      sp.name = name;
      if (uid !== undefined) sp.uid = uid;
    }
  }
  for (const e of s.entries) {
    if (e.key === key) e.name = name;
  }
  writeAll(id, meta(s), s.entries);
  return load(id);
}

function saveNotes(id, markdown) {
  fs.writeFileSync(notesFileFor(id), markdown);
  return notesFileFor(id);
}

function audioPaths(id) {
  const out = {};
  for (const who of ['me', 'them']) {
    const p = audioFileFor(id, who);
    if (fs.existsSync(p)) out[who] = p;
  }
  return out;
}

function list() {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    const id = f.slice(0, -'.jsonl'.length);
    const s = load(id);
    if (!s) continue;
    const last = s.entries.length ? s.entries[s.entries.length - 1].t : s.startedAt;
    out.push({
      id,
      title: s.title,
      startedAt: s.startedAt,
      endedAt: last,
      lines: s.entries.length,
      words: s.entries.reduce((n, e) => n + e.text.split(/\s+/).length, 0),
      hasNotes: Boolean(s.notes),
      refined: s.refined,
      speakers: s.speakers.map((sp) => sp.name).filter(Boolean),
    });
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

function remove(id) {
  const files = [fileFor(id), notesFileFor(id), audioFileFor(id, 'me'), audioFileFor(id, 'them')];
  for (const f of files) {
    try { fs.unlinkSync(f); } catch (_) { /* already gone */ }
  }
}

module.exports = {
  init, folder, create, append, setTitle, load, applyFinal, renameSpeaker,
  saveNotes, audioPaths, audioFileFor, list, remove,
};
