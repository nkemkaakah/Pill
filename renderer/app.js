/* global window, document, marked, DOMPurify, hljs, PillAudio */
(function () {
  const api = window.pill;
  const $ = (id) => document.getElementById(id);

  // ---------- elements ----------
  const body = document.body;
  const statusMain = $('status-main');
  const statusSub = $('status-sub');
  const meter = $('meter');
  const meterCtx = meter.getContext('2d');
  const messagesEl = $('messages');
  const emptyEl = $('empty');
  const input = $('input');
  const composer = $('composer');
  const optShot = $('opt-shot');
  const optSmart = $('opt-smart');
  const quick = $('quick');
  const transcriptEl = $('transcript');
  const transcriptEmpty = $('transcript-empty');
  const settingsForm = $('settings');
  const recBtn = $('btn-rec');
  const recLabel = $('rec-label');

  // ---------- state ----------
  let cfg = null;
  let mode = 'pill';
  let tab = 'chat';
  let busy = false;
  let activeId = null;
  let assistantEl = null;
  let assistantText = '';
  let renderScheduled = false;
  let session = null;          // { id, startedAt, title }
  let lines = 0;
  let lastLine = '';
  let recStart = 0;
  let recTimer = null;
  let notesText = '';
  let perms = { mic: 'unknown', screen: 'unknown' };
  const levelHistory = new Array(9).fill(0);

  // ---------- markdown ----------
  marked.setOptions({ gfm: true, breaks: true });
  const renderMarkdown = (text) => DOMPurify.sanitize(marked.parse(text || ''), { USE_PROFILES: { html: true } });

  function decorateCode(container) {
    container.querySelectorAll('pre code').forEach((code) => {
      if (!code.dataset.hl) {
        try { hljs.highlightElement(code); } catch (_) { /* unknown language */ }
        code.dataset.hl = '1';
      }
      const pre = code.parentElement;
      if (!pre.querySelector('.copy')) {
        const b = document.createElement('button');
        b.className = 'copy';
        b.textContent = 'Copy';
        b.addEventListener('click', async () => {
          await navigator.clipboard.writeText(code.innerText);
          b.textContent = 'Copied';
          setTimeout(() => { b.textContent = 'Copy'; }, 1200);
        });
        pre.appendChild(b);
      }
    });
    container.querySelectorAll('a[href]').forEach((a) => {
      a.addEventListener('click', (e) => { e.preventDefault(); api.openExternal(a.href); });
    });
  }

  function copyButton(getText, label = 'Copy') {
    const b = document.createElement('button');
    b.textContent = label;
    b.addEventListener('click', async () => {
      await navigator.clipboard.writeText(getText());
      b.textContent = 'Copied';
      setTimeout(() => { b.textContent = label; }, 1200);
    });
    return b;
  }

  // ---------- capsule ----------
  function drawMeter(level) {
    levelHistory.push(level);
    levelHistory.shift();
    const w = meter.width, h = meter.height;
    meterCtx.clearRect(0, 0, w, h);
    meterCtx.fillStyle = body.classList.contains('recording') ? '#f2716a' : '#7f7d77';
    const bars = levelHistory.length, gap = 2, bw = (w - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const v = Math.min(1, levelHistory[i] * 6);
      const bh = Math.max(3, v * h);
      meterCtx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
    }
  }
  drawMeter(0);

  const fmtClock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
  };

  function refreshStatus() {
    if (busy) { statusMain.textContent = 'Thinking'; statusSub.textContent = ''; return; }
    if (listener.active) {
      statusMain.textContent = 'Recording';
      statusSub.textContent = lastLine ? `· ${lastLine}` : `· ${lines} line${lines === 1 ? '' : 's'}`;
    } else if (session && lines) {
      statusMain.textContent = session.title || 'Session';
      statusSub.textContent = `· ${lines} lines`;
    } else {
      statusMain.textContent = 'Pill';
      statusSub.textContent = mode === 'pill' ? '⌃⌥↩ to open · drag me' : '';
    }
  }

  function tickRec() {
    recLabel.textContent = fmtClock(Date.now() - recStart);
  }

  // ---------- window mode / tabs ----------
  const setMode = (next, size) => api.setMode(next, size);

  function applyMode(next, size) {
    mode = next;
    body.classList.toggle('mode-panel', mode === 'panel');
    body.classList.toggle('mode-pill', mode === 'pill');
    document.querySelectorAll('#sizes button').forEach((b) => b.classList.toggle('on', b.dataset.size === size));
    if (mode === 'panel') { api.focus(); if (tab === 'chat') setTimeout(() => input.focus(), 30); refreshSetup(); }
    refreshStatus();
  }

  function showTab(name) {
    tab = name;
    document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'chat') setTimeout(() => input.focus(), 20);
    if (name === 'settings') fillSettings();
    if (name === 'notes') refreshSessions();
    if (name === 'transcript') transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  // ---------- setup strip ----------
  async function refreshSetup() {
    cfg = await api.getConfig();
    perms = await api.permissionStatus();
    const rows = {
      key: !cfg.chatReady,
      screen: perms.screen !== 'granted',
      mic: perms.mic !== 'granted',
    };
    let any = false;
    for (const [k, needs] of Object.entries(rows)) {
      document.querySelector(`.setup-row[data-item="${k}"]`).classList.toggle('on', needs);
      any = any || needs;
    }
    $('setup').classList.toggle('on', any);
    $('perm-state').textContent = `mic: ${perms.mic} · screen: ${perms.screen}`;
  }
  async function grantPerms() {
    perms = await api.requestPermissions();
    await refreshSetup();
    if (perms.screen !== 'granted') {
      $('setup-note').textContent = 'macOS only applies Screen Recording after a restart: enable Pill (or Electron) in System Settings → Privacy & Security → Screen Recording, then quit (⌃⌥X) and reopen.';
    } else {
      $('setup-note').textContent = '';
    }
  }
  $('setup-grant').addEventListener('click', grantPerms);
  $('setup-grant-mic').addEventListener('click', grantPerms);
  $('btn-perms').addEventListener('click', async () => {
    await grantPerms();
    $('perm-state').textContent = `mic: ${perms.mic} · screen: ${perms.screen}` + (perms.screen !== 'granted' ? ' — quit and reopen after enabling' : '');
  });

  // ---------- chat ----------
  const scrollToBottom = () => { messagesEl.scrollTop = messagesEl.scrollHeight; };

  function addUser(text, withShot) {
    emptyEl.style.display = 'none';
    const el = document.createElement('div');
    el.className = 'msg msg-user';
    el.textContent = text;
    if (withShot) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'screenshot';
      el.appendChild(tag);
    }
    messagesEl.appendChild(el);
  }

  function addAssistant() {
    const el = document.createElement('div');
    el.className = 'msg msg-assistant';
    el.innerHTML = '<div class="body"><span class="thinking"></span></div><div class="msg-meta"></div>';
    messagesEl.appendChild(el);
    scrollToBottom();
    return el;
  }

  function paintAssistant(el, text, final) {
    const bodyEl = el.querySelector('.body');
    bodyEl.innerHTML = renderMarkdown(text) || '<span class="thinking"></span>';
    decorateCode(bodyEl);
    const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
    if (nearBottom || final) scrollToBottom();
  }

  function scheduleRender(final) {
    if (final) { if (assistantEl) paintAssistant(assistantEl, assistantText, true); return; }
    if (renderScheduled) return;
    renderScheduled = true;
    const el = assistantEl;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (el && el === assistantEl) paintAssistant(el, assistantText, false);
    });
  }

  function setBusy(v) {
    busy = v;
    body.classList.toggle('busy', v);
    refreshQuick();
    $('btn-snap').classList.toggle('busy', v);
    refreshStatus();
  }

  function refreshQuick() {
    quick.querySelectorAll('button').forEach((b) => {
      const needsTranscript = b.dataset.needs === 'transcript';
      b.disabled = busy || (needsTranscript && !lines);
      if (needsTranscript && !lines) b.title = 'Press Rec first — this needs a transcript';
    });
    const scope = cfg ? cfg.transcriptScope : 'recent';
    const bits = [];
    if (optShot.checked) bits.push('screenshot');
    if (lines) bits.push(scope === 'all' ? 'whole transcript' : `last ${cfg ? cfg.transcriptWindowMinutes : 10} min of transcript`);
    $('context-hint').textContent = bits.length ? `Context: ${bits.join(' + ')}` : 'Context: text only';
  }

  async function submitQuestion(text) {
    const q = (text || '').trim();
    if (!q || busy) return;
    input.value = '';
    autosize();
    await api.ask({ question: q, withScreenshot: optShot.checked, smart: optSmart.checked });
  }

  async function runAction(action) {
    if (busy) return;
    if (mode !== 'panel') await setMode('panel');
    showTab('chat');
    await api.ask({ action, smart: optSmart.checked });
  }

  api.onChatStart(({ id, question, withScreenshot }) => {
    activeId = id;
    assistantText = '';
    showTab('chat');
    addUser(question, withScreenshot);
    assistantEl = addAssistant();
    setBusy(true);
  });
  api.onChatDelta(({ id, text }) => { if (id === activeId) { assistantText += text; scheduleRender(false); } });
  api.onChatNotice(({ id, text }) => {
    if (id !== activeId || !assistantEl) return;
    const n = document.createElement('div');
    n.className = 'notice';
    n.textContent = text;
    assistantEl.insertBefore(n, assistantEl.firstChild);
  });
  api.onChatDone(({ id, text, error, aborted, model }) => {
    if (id !== activeId) return;
    assistantText = text || '';
    if (assistantEl) {
      const bodyEl = assistantEl.querySelector('.body');
      if (error) {
        bodyEl.innerHTML = '';
        const e = document.createElement('div');
        e.className = 'error';
        e.textContent = error;
        bodyEl.appendChild(e);
      } else {
        scheduleRender(true);
      }
      const meta = assistantEl.querySelector('.msg-meta');
      meta.innerHTML = '';
      const m = document.createElement('span');
      m.textContent = aborted ? `stopped · ${model}` : model;
      meta.appendChild(m);
      if (assistantText) meta.appendChild(copyButton(() => assistantText, 'Copy answer'));
    }
    setBusy(false);
    assistantEl = null;
  });

  composer.addEventListener('submit', (e) => { e.preventDefault(); submitQuestion(input.value); });
  $('btn-stop').addEventListener('click', () => api.abort());
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(input.value); }
    if (e.key === 'Escape') setMode('pill');
  });
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  }
  input.addEventListener('input', autosize);
  quick.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b && !b.disabled) runAction(b.dataset.action);
  });
  optShot.addEventListener('change', () => { api.setConfig({ attachScreenshot: optShot.checked }); refreshQuick(); });

  // ---------- recording ----------
  const listener = new PillAudio.Listener({
    chunkMs: () => (cfg ? cfg.chunkSeconds : 6) * 1000,
    silenceGate: () => (cfg ? cfg.silenceGate : 0.012),
    onLevel: drawMeter,
    onChunk: async (who, buffer, mime) => {
      const res = await api.sendAudioChunk(who, buffer, mime);
      if (res && res.error) { lastLine = res.error; refreshStatus(); }
    },
    onError: (who, msg) => { lastLine = `${who}: ${msg}`; refreshStatus(); },
  });

  async function startRecording() {
    if (listener.active) return;
    statusMain.textContent = 'Starting';
    statusSub.textContent = '';
    const res = await listener.start();
    if (!listener.active) {
      lastLine = res.errors.join(' · ');
      refreshStatus();
      if (mode !== 'panel') await setMode('panel');
      showTab('chat');
      $('setup-note').textContent = res.errors.join(' · ');
      refreshSetup();
      return;
    }
    await api.recordingStarted();
    body.classList.add('recording');
    recBtn.setAttribute('aria-pressed', 'true');
    recBtn.title = 'Stop recording (⌃⌥R)';
    recStart = Date.now();
    tickRec();
    recTimer = setInterval(tickRec, 1000);
    lastLine = res.them ? '' : 'mic only — system audio unavailable';
    if (cfg && !cfg.sttEnabled) lastLine = 'transcription is off in settings';
    refreshStatus();
  }

  async function stopRecording() {
    if (!listener.active) return;
    listener.stop();
    await api.recordingStopped();
    body.classList.remove('recording');
    recBtn.setAttribute('aria-pressed', 'false');
    recBtn.title = 'Start recording (⌃⌥R)';
    clearInterval(recTimer);
    recLabel.textContent = 'Rec';
    refreshStatus();
    if (lines && mode === 'panel') { showTab('notes'); }
  }

  const toggleRecording = () => (listener.active ? stopRecording() : startRecording());
  recBtn.addEventListener('click', toggleRecording);

  function addLine(entry) {
    lines += 1;
    lastLine = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text;
    transcriptEmpty.style.display = 'none';
    const line = document.createElement('div');
    line.className = `tline ${entry.who}`;
    line.innerHTML = '<span class="who"></span><span class="text"></span>';
    const whoEl = line.querySelector('.who');
    whoEl.textContent = entry.name || entry.who;
    if (entry.key && entry.key !== 'me' && entry.key !== 'unknown') {
      whoEl.classList.add('clickable');
      whoEl.title = 'Click to name this speaker';
      whoEl.addEventListener('click', () => promptRename(entry.key, entry.name || 'Speaker'));
    }
    line.querySelector('.text').textContent = entry.text;
    transcriptEl.appendChild(line);
    if (tab === 'transcript') transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  // ---------- speakers ----------
  function renderSpeakerChips() {
    const box = $('speaker-chips');
    box.innerHTML = '';
    const list = (session && session.speakers) || [];
    box.classList.toggle('on', list.length > 0);
    for (const sp of list) {
      const named = Boolean(sp.uid);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `speaker-chip${named ? ' named' : ''}`;
      chip.title = named ? 'Recognised from a previous meeting — click to correct the name' : 'Click to name this voice; Pill will recognise it in future meetings';
      chip.innerHTML = '<span class="nm"></span><span class="secs"></span>';
      chip.querySelector('.nm').textContent = named ? sp.name : `${sp.name} — name?`;
      chip.querySelector('.secs').textContent = `${Math.round(sp.seconds || 0)}s`;
      chip.addEventListener('click', () => beginChipRename(chip, sp));
      box.appendChild(chip);
    }
  }

  function beginChipRename(chip, sp) {
    const input = document.createElement('input');
    input.className = 'chip-input';
    input.value = sp.uid ? sp.name : '';
    input.placeholder = sp.name;
    chip.replaceWith(input);
    input.focus();
    input.select();
    let finished = false;
    const done = async (commit) => {
      if (finished) return;
      finished = true;
      const name = input.value.trim();
      if (commit && name && session) {
        const res = await api.renameSpeaker(session.id, sp.key, name);
        if (res && res.error) { if (input.isConnected) input.replaceWith(chip); setBanner('bad', res.error); return; }
        if (input.isConnected) input.replaceWith(chip); // transcript:reset re-renders everything anyway
      } else {
        input.replaceWith(chip);
      }
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(true);
      if (e.key === 'Escape') done(false);
    });
    input.addEventListener('blur', () => done(false));
  }

  function promptRename(key, current) {
    showTab('transcript');
    const chips = $('speaker-chips');
    const list = (session && session.speakers) || [];
    const idx = list.findIndex((x) => x.key === key);
    const chip = chips.children[idx];
    if (chip && chip.classList.contains('speaker-chip')) beginChipRename(chip, list[idx]);
    else if (session) {
      const name = window.prompt(`Name for ${current}?`);
      if (name && name.trim()) api.renameSpeaker(session.id, key, name.trim());
    }
  }

  // ---------- refine banner ----------
  const STAGES = { starting: 'starting the local engine', transcribing: 'transcribing the recording', labelling: 'labelling speakers' };
  function setBanner(kind, text) {
    const b = $('refine-banner');
    b.className = `refine-banner on ${kind}`;
    b.innerHTML = kind === 'working' ? '<span class="spin"></span><span class="txt"></span>' : '<span class="txt"></span>';
    b.querySelector('.txt').textContent = text;
  }
  function clearBanner() { $('refine-banner').className = 'refine-banner'; }

  function resetTranscript(newSession, entries, { keepNotes = false } = {}) {
    const sameSession = session && newSession && session.id === newSession.id;
    session = newSession;
    lines = 0;
    lastLine = '';
    transcriptEl.querySelectorAll('.tline').forEach((n) => n.remove());
    transcriptEmpty.style.display = '';
    (entries || []).forEach(addLine);
    if (!sameSession && !keepNotes) {
      notesText = '';
      $('notes-body').innerHTML = '';
      $('notes-meta').innerHTML = '';
    }
    if (!sameSession) clearBanner();
    renderSpeakerChips();
    refreshSessionUi();
  }

  function refreshSessionUi() {
    $('tab-lines').textContent = lines ? String(lines) : '';
    const title = $('session-title');
    title.value = session ? (session.title || '') : '';
    title.disabled = !session;
    const when = session ? new Date(session.startedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '';
    $('session-sub').textContent = session ? `${when} · ${lines} line${lines === 1 ? '' : 's'}${listener.active ? ' · recording' : ''}` : 'No session yet';
    $('notes-title').textContent = session ? (session.title || 'Untitled session') : 'No session';
    $('notes-sub').textContent = session
      ? (lines ? `${when} · ${lines} lines${notesText ? ' · notes saved' : ''}` : 'Nothing transcribed yet.')
      : 'Record a call, then generate notes.';
    $('btn-notes').disabled = !session || !lines;
    $('btn-notes').textContent = notesText ? 'Regenerate notes' : 'Generate notes';
    refreshQuick();
    refreshStatus();
  }

  api.onTranscript((entry) => { addLine(entry); refreshSessionUi(); });
  api.onTranscriptReset(({ session: s, entries }) => resetTranscript(s, entries));

  api.onRefineProgress(({ stage }) => {
    setBanner('working', `Refining transcript locally — ${STAGES[stage] || stage}…`);
    showTab('transcript');
  });
  api.onRefineDone(({ stats, seconds, error, skipped, reason }) => {
    if (error) { setBanner('bad', `Local refinement failed: ${error}`); return; }
    if (skipped) { setBanner('hint', reason || 'Local engine not installed.'); return; }
    const named = (session && session.speakers ? session.speakers.filter((x) => x.uid).length : 0);
    const voices = stats ? stats.voices : 0;
    setBanner('working', '');
    clearBanner();
    if (voices > named) setBanner('hint', `Done in ${seconds}s — ${voices} voice${voices === 1 ? '' : 's'} found. Click a name chip above to tell Pill who's who; it will recognise them next time.`);
  });
  $('btn-rerun').addEventListener('click', () => { if (session) { setBanner('working', 'Refining transcript locally…'); api.runRefine(session.id); } });

  $('session-title').addEventListener('change', (e) => {
    if (!session) return;
    session.title = e.target.value.trim();
    api.renameSession(session.id, session.title);
    refreshSessionUi();
  });
  $('btn-copy-transcript').addEventListener('click', async () => {
    const text = [...transcriptEl.querySelectorAll('.tline')].map((l) => `${l.querySelector('.who').textContent}: ${l.querySelector('.text').textContent}`).join('\n');
    await navigator.clipboard.writeText(text);
  });
  $('btn-new-session').addEventListener('click', async () => {
    if (listener.active) await stopRecording();
    await startRecording();
  });

  // ---------- notes + sessions ----------
  let notesRenderScheduled = false;
  function renderNotes(final) {
    if (notesRenderScheduled && !final) return;
    notesRenderScheduled = true;
    requestAnimationFrame(() => {
      notesRenderScheduled = false;
      const el = $('notes-body');
      el.innerHTML = renderMarkdown(notesText.replace(/^#\s+.+\n?/, ''));
      decorateCode(el);
    });
  }

  $('btn-notes').addEventListener('click', () => api.generateNotes());
  $('btn-notes-stop').addEventListener('click', () => api.abortNotes());
  api.onNotesStart(() => {
    notesText = '';
    $('notes-body').innerHTML = '<span class="thinking"></span>';
    $('notes-meta').innerHTML = '';
    document.querySelector('.session-card').classList.add('notes-busy');
    showTab('notes');
  });
  api.onNotesDelta(({ text }) => { notesText += text; renderNotes(false); });
  api.onNotesDone(({ text, error, file }) => {
    document.querySelector('.session-card').classList.remove('notes-busy');
    notesText = text || '';
    renderNotes(true);
    const meta = $('notes-meta');
    meta.innerHTML = '';
    if (error) {
      const e = document.createElement('span');
      e.className = 'error';
      e.textContent = error;
      meta.appendChild(e);
    } else {
      const m = document.createElement('span');
      m.textContent = 'saved as Markdown';
      meta.appendChild(m);
      meta.appendChild(copyButton(() => notesText, 'Copy notes'));
      const t = /^#\s+(.+)$/m.exec(notesText);
      if (t && session && !session.title) session.title = t[1].trim();
    }
    refreshSessionUi();
    refreshSessions();
  });

  async function refreshSessions() {
    let list = await api.listSessions();
    const q = ($('session-search').value || '').trim().toLowerCase();
    if (q) {
      list = list.filter((s) => (s.title || '').toLowerCase().includes(q)
        || (s.speakers || []).some((n) => n.toLowerCase().includes(q))
        || s.id.includes(q));
    }
    const ul = $('session-list');
    ul.innerHTML = '';
    $('sessions-empty').style.display = list.length ? 'none' : '';
    for (const s of list) {
      const li = document.createElement('li');
      if (session && session.id === s.id) li.classList.add('on');
      const main = document.createElement('div');
      main.className = 's-main';
      const title = document.createElement('span');
      title.className = 's-title';
      title.textContent = s.title || `Session ${s.id.replace('_', ' ').replace(/-(\d\d)$/, ':$1')}`;
      const sub = document.createElement('span');
      sub.className = 's-sub';
      const when = new Date(s.startedAt).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const who = (s.speakers || []).filter((n) => n && !/^Speaker \d+$/.test(n));
      sub.textContent = `${when} · ${fmtClock(s.endedAt - s.startedAt)} · ${s.words} words${who.length ? ` · with ${who.join(', ')}` : ''}`;
      main.append(title, sub);
      main.title = 'Open: loads this transcript and notes so you can ask about it';
      main.addEventListener('click', async () => {
        const res = await api.loadSession(s.id);
        if (res && res.error) { $('notes-sub').textContent = res.error; return; }
        notesText = res.notes || '';
        renderNotes(true);
        refreshSessionUi();
        refreshSessions();
      });
      li.appendChild(main);
      if (s.hasNotes) {
        const tag = document.createElement('span');
        tag.className = 's-notes';
        tag.textContent = 'notes';
        li.appendChild(tag);
      }
      const del = document.createElement('button');
      del.className = 'text-btn danger';
      del.textContent = 'Delete';
      del.addEventListener('click', async () => {
        if (del.textContent !== 'Sure?') { del.textContent = 'Sure?'; setTimeout(() => { del.textContent = 'Delete'; }, 2500); return; }
        await api.removeSession(s.id);
        refreshSessions();
      });
      li.appendChild(del);
      ul.appendChild(li);
    }
  }
  $('btn-open-folder').addEventListener('click', () => api.openSessionsFolder());
  $('session-search').addEventListener('input', () => refreshSessions());

  // ---------- capsule + footer buttons ----------
  // The status area is a drag handle (move the pill anywhere). Opening lives on
  // the chevron and ⌃⌥↩ — drag regions swallow clicks, so it can't be both.
  $('btn-expand').addEventListener('click', () => setMode(mode === 'pill' ? 'panel' : 'pill'));
  $('btn-snap').addEventListener('click', async () => {
    if (mode !== 'panel') await setMode('panel');
    showTab('chat');
    optShot.checked = true;
    refreshQuick();
    input.focus();
  });
  document.querySelectorAll('#sizes button').forEach((b) => b.addEventListener('click', () => setMode('panel', b.dataset.size)));
  $('btn-eye').addEventListener('click', async () => { cfg = await api.setConfig({ invisible: !cfg.invisible }); });
  $('btn-clear').addEventListener('click', async () => {
    await api.clearChat();
    messagesEl.querySelectorAll('.msg').forEach((n) => n.remove());
    emptyEl.style.display = '';
    showTab('chat');
  });
  $('btn-quit').addEventListener('click', () => api.quit());

  document.addEventListener('keydown', (e) => {
    const metaKey = e.metaKey || e.ctrlKey;
    if (metaKey && e.key === ',') { e.preventDefault(); showTab('settings'); }
    if (metaKey && e.key.toLowerCase() === 'k') { e.preventDefault(); $('btn-clear').click(); }
    if (e.key === 'Escape' && tab !== 'chat') showTab('chat');
  });

  // ---------- settings ----------
  function showProviderBlocks() {
    const p = settingsForm.provider.value;
    document.querySelectorAll('.provider-block').forEach((b) => b.classList.toggle('on', b.dataset.provider === p));
  }
  settingsForm.provider.addEventListener('change', showProviderBlocks);

  function fillSettings() {
    if (!cfg) return;
    const f = settingsForm;
    f.provider.value = cfg.provider || 'anthropic';
    showProviderBlocks();
    f.anthropicApiKey.value = '';
    f.anthropicApiKey.placeholder = cfg.hasAnthropicKey ? cfg.anthropicApiKey : 'sk-ant-…';
    $('anthropic-key-state').textContent = cfg.hasAnthropicKey ? 'A key is saved. Paste a new one to replace it.' : 'No key yet.';
    f.anthropicFastModel.value = cfg.anthropicFastModel;
    f.anthropicSmartModel.value = cfg.anthropicSmartModel;
    f.apiKey.value = '';
    f.apiKey.placeholder = cfg.hasKey ? cfg.apiKey : 'sk-…';
    $('key-state').textContent = cfg.hasKey ? 'A key is saved. Paste a new one to replace it.' : 'No key yet.';
    f.baseUrl.value = cfg.baseUrl;
    f.fastModel.value = cfg.fastModel;
    f.smartModel.value = cfg.smartModel;
    f.reasoningEffort.value = cfg.reasoningEffort;
    f.maxOutputTokens.value = cfg.maxOutputTokens;
    f.sttEnabled.checked = cfg.sttEnabled;
    f.autoRecord.checked = cfg.autoRecord;
    f.sttModel.value = cfg.sttModel;
    f.sttBaseUrl.value = cfg.sttBaseUrl;
    f.chunkSeconds.value = cfg.chunkSeconds;
    f.transcriptScope.value = cfg.transcriptScope;
    f.transcriptWindowMinutes.value = cfg.transcriptWindowMinutes;
    f.invisible.checked = cfg.invisible;
    f.attachScreenshot.checked = cfg.attachScreenshot;
    f.systemPrompt.value = cfg.systemPrompt || '';
    f.localRefine.checked = cfg.localRefine;
    f.sidecarPath.value = cfg.sidecarPath || '';
    $('perm-state').textContent = `mic: ${perms.mic} · screen: ${perms.screen}`;
    refreshSidecarState();
  }

  async function refreshSidecarState() {
    const st = await api.sidecarStatus();
    $('sidecar-state').textContent = st.available
      ? `Found: ${st.path}`
      : (st.reason || 'Not found.');
  }

  settingsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = settingsForm;
    const patch = {
      provider: f.provider.value,
      anthropicFastModel: f.anthropicFastModel.value.trim() || 'claude-sonnet-5',
      anthropicSmartModel: f.anthropicSmartModel.value.trim() || 'claude-opus-5',
      baseUrl: f.baseUrl.value.trim() || 'https://api.openai.com/v1',
      fastModel: f.fastModel.value.trim(),
      smartModel: f.smartModel.value.trim(),
      reasoningEffort: f.reasoningEffort.value,
      maxOutputTokens: Number(f.maxOutputTokens.value) || 4096,
      sttEnabled: f.sttEnabled.checked,
      autoRecord: f.autoRecord.checked,
      sttModel: f.sttModel.value.trim(),
      sttBaseUrl: f.sttBaseUrl.value.trim() || 'https://api.openai.com/v1',
      chunkSeconds: Math.min(20, Math.max(3, Number(f.chunkSeconds.value) || 6)),
      transcriptScope: f.transcriptScope.value,
      transcriptWindowMinutes: Math.min(60, Math.max(2, Number(f.transcriptWindowMinutes.value) || 10)),
      invisible: f.invisible.checked,
      attachScreenshot: f.attachScreenshot.checked,
      systemPrompt: f.systemPrompt.value,
      localRefine: f.localRefine.checked,
      sidecarPath: f.sidecarPath.value.trim(),
    };
    if (f.apiKey.value.trim()) patch.apiKey = f.apiKey.value.trim();
    if (f.anthropicApiKey.value.trim()) patch.anthropicApiKey = f.anthropicApiKey.value.trim();
    cfg = await api.setConfig(patch);
    optShot.checked = cfg.attachScreenshot;
    await refreshSetup();
    refreshQuick();
    showTab('chat');
  });

  // ---------- status / commands from main ----------
  const prettyAccel = (a) => (a || '')
    .replace('CommandOrControl', '⌘').replace('Command', '⌘').replace('Control', '⌃')
    .replace('Alt', '⌥').replace('Shift', '⇧').replace('Return', '↩').replace('Space', '␣')
    .replace('Up', '↑').replace('Down', '↓').replace('Left', '←').replace('Right', '→')
    .replace(/\+/g, '');

  function keyToAccelPart(e) {
    const k = e.key;
    if (k === ' ' || e.code === 'Space') return 'Space';
    if (k === 'Enter') return 'Return';
    if (k === 'ArrowUp') return 'Up';
    if (k === 'ArrowDown') return 'Down';
    if (k === 'ArrowLeft') return 'Left';
    if (k === 'ArrowRight') return 'Right';
    if (k === 'Tab') return 'Tab';
    if (/^F\d{1,2}$/.test(k)) return k;
    if (k.length === 1) return k.toUpperCase();
    return null;
  }

  function captureShortcut(btn, name) {
    const before = btn.textContent;
    btn.textContent = 'press keys…';
    btn.classList.add('capturing');
    const onKey = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') { cleanup(); btn.textContent = before; return; }
      if (e.key === 'Backspace' || e.key === 'Delete') { cleanup(); await api.setShortcuts({ [name]: '' }); return; }
      if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // wait for the real key
      const part = keyToAccelPart(e);
      if (!part) return;
      const mods = [];
      if (e.ctrlKey) mods.push('Control');
      if (e.altKey) mods.push('Alt');
      if (e.shiftKey) mods.push('Shift');
      if (e.metaKey) mods.push('Command');
      if (!mods.length) { btn.textContent = 'needs a modifier'; return; }
      cleanup();
      await api.setShortcuts({ [name]: [...mods, part].join('+') });
    };
    const cleanup = () => {
      document.removeEventListener('keydown', onKey, true);
      btn.classList.remove('capturing');
    };
    document.addEventListener('keydown', onKey, true);
  }

  function renderShortcuts(shortcuts) {
    const list = $('shortcut-list');
    list.innerHTML = '';
    for (const [name, st] of Object.entries(shortcuts || {})) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = st.label || name;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'accel';
      if (!st.accel) { btn.textContent = 'off'; btn.classList.add('off'); }
      else {
        btn.textContent = prettyAccel(st.accel);
        if (!st.ok) { btn.classList.add('taken'); btn.title = st.why === 'duplicate' ? 'Assigned twice — change one' : 'Another app owns this shortcut'; }
      }
      btn.addEventListener('click', () => captureShortcut(btn, name));
      li.append(label, btn);
      list.appendChild(li);
    }
  }

  api.onStatus((s) => {
    if (cfg) cfg.invisible = s.invisible;
    body.classList.toggle('invisible', Boolean(s.invisible));
    renderShortcuts(s.shortcuts);
    if (s.session && session && s.session.id === session.id) {
      session.title = s.session.title;
      session.speakers = s.session.speakers || session.speakers;
    }
  });
  $('btn-shortcuts-reset').addEventListener('click', async () => {
    await api.setShortcuts({ toggle: 'Control+Alt+Space', expand: 'Control+Alt+Return', ask: 'Control+Alt+A', solve: 'Control+Alt+S', record: 'Control+Alt+R', invisible: 'Control+Alt+I', up: 'Control+Alt+Up', down: 'Control+Alt+Down', left: 'Control+Alt+Left', right: 'Control+Alt+Right', quit: 'Control+Alt+X' });
  });
  api.onMode(({ mode: m, size }) => applyMode(m, size));
  api.onCommand(({ cmd, withScreenshot }) => {
    if (cmd === 'focus-input') { showTab('chat'); if (withScreenshot) { optShot.checked = true; refreshQuick(); } input.focus(); }
    if (cmd === 'toggle-record') toggleRecording();
  });

  // ---------- boot ----------
  (async () => {
    cfg = await api.getConfig();
    optShot.checked = cfg.attachScreenshot;
    applyMode(cfg.mode, cfg.panelSize);
    body.classList.toggle('invisible', Boolean(cfg.invisible));
    const t = await api.getTranscript();
    resetTranscript(t.session, t.entries);
    await refreshSetup();
    refreshQuick();
    if (!cfg.chatReady) {
      await setMode('panel');
      showTab('settings');
      statusMain.textContent = 'Pill';
      statusSub.textContent = 'add an API key';
    } else {
      showTab('chat');
      refreshStatus();
      if (cfg.autoRecord) startRecording();
    }
  })();
})();
