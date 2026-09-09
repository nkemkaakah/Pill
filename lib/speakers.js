'use strict';
// The saved speaker roster: one voiceprint per named person, in
// <userData>/speakers.json. When a named speaker is re-identified in a later
// meeting their embedding is nudged toward the new sample (running average),
// so recognition improves with every call.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let file = null;
let roster = [];

function init(app) {
  file = path.join(app.getPath('userData'), 'speakers.json');
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    roster = Array.isArray(raw) ? raw.filter((s) => s && s.uid && Array.isArray(s.embedding)) : [];
  } catch (_) {
    roster = [];
  }
  return roster;
}

function save() {
  try {
    fs.writeFileSync(file, JSON.stringify(roster, null, 2));
  } catch (err) {
    console.error('[pill] speakers save failed:', err.message);
  }
}

function list() {
  return roster.map(({ uid, name, meetings, updatedAt }) => ({ uid, name, meetings, updatedAt }));
}

function all() {
  return roster;
}

function get(uid) {
  return roster.find((s) => s.uid === uid) || null;
}

/** Create a named speaker from a session voiceprint. Returns the record. */
function enroll(name, embedding) {
  const rec = {
    uid: crypto.randomUUID(),
    name: String(name).trim(),
    embedding: Array.from(embedding),
    meetings: 1,
    updatedAt: Date.now(),
  };
  roster.push(rec);
  save();
  return rec;
}

/**
 * Re-identified in a new meeting: blend the new voiceprint in.
 * weight is the new sample's share (0.3 keeps history dominant but adapts).
 */
function reinforce(uid, embedding, weight = 0.3) {
  const rec = get(uid);
  if (!rec || !Array.isArray(embedding) || embedding.length !== rec.embedding.length) return rec;
  for (let i = 0; i < rec.embedding.length; i++) {
    rec.embedding[i] = rec.embedding[i] * (1 - weight) + embedding[i] * weight;
  }
  rec.meetings = (rec.meetings || 0) + 1;
  rec.updatedAt = Date.now();
  save();
  return rec;
}

function rename(uid, name) {
  const rec = get(uid);
  if (!rec) return null;
  rec.name = String(name).trim();
  rec.updatedAt = Date.now();
  save();
  return rec;
}

function remove(uid) {
  const i = roster.findIndex((s) => s.uid === uid);
  if (i >= 0) roster.splice(i, 1);
  save();
}

module.exports = { init, list, all, get, enroll, reinforce, rename, remove };
