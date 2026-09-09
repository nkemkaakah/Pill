/* global window, document, marked, DOMPurify, hljs, PillAudio */
(function () {
  const api = window.pill;
  const $ = (id) => document.getElementById(id);

  // ---------- elements ----------
  const body = document.body;
  const capsule = $('capsule');
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

  // ---------- state ----------
  let cfg = null;
  let mode = 'pill';
  let view = 'chat';
  let busy = false;
  let activeId = null;
  let assistantEl = null;
  let assistantText = '';
  let renderScheduled = false;
  let transcriptCount = 0;
  let lastLine = '';
  let levelHistory = new Array(9).fill(0);

  // ---------- markdown ----------
  marked.setOptions({ gfm: true, breaks: true });

  function renderMarkdown(text) {
    const raw = marked.parse(text || '');
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }

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

  // ---------- pill meter ----------
  function drawMeter(level) {
    levelHistory.push(level);
    levelHistory.shift();
    const w = meter.width, h = meter.height;
    meterCtx.clearRect(0, 0, w, h);
    const listening = body.classList.contains('listening');
    meterCtx.fillStyle = listening ? '#7fd1b9' : '#7d7b75';
    const bars = levelHistory.length;
    const gap = 2, bw = (w - gap * (bars - 1)) / bars;
    for (let i = 0; i < bars; i++) {
      const v = Math.min(1, levelHistory[i] * 6);
      const bh = Math.max(3, v * h);
      meterCtx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh);
    }
  }
  drawMeter(0);

  // ---------- status line ----------
  function setStatus(main, sub) {
    if (main !== undefined) statusMain.textContent = main;
    if (sub !== undefined) statusSub.textContent = sub;
  }

  function refreshStatus() {
    if (busy) { setStatus('Thinking', ''); return; }
    if (listener.active) {
      setStatus('Listening', lastLine ? `· ${lastLine}` : `· ${transcriptCount} lines`);
    } else {
      setStatus('Pill', mode === 'pill' ? 'click to ask' : '');
    }
  }

  // ---------- window mode ----------
  async function setMode(next, size) {
    await api.setMode(next, size);
  }

  function applyMode(next, size) {
    mode = next;
    body.classList.toggle('mode-panel', mode === 'panel');
    body.classList.toggle('mode-pill', mode === 'pill');
    document.querySelectorAll('#sizes button').forEach((b) => b.classList.toggle('on', b.dataset.size === size));
    if (mode === 'panel') { api.focus(); setTimeout(() => input.focus(), 30); }
    refreshStatus();
  }

  function showView(name) {
    view = name;
    document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
    if (name === 'chat') setTimeout(() => input.focus(), 20);
    if (name === 'settings') fillSettings();
  }

  // ---------- chat ----------
  function scrollToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }

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

  function scheduleRender(final) {
    if (renderScheduled && !final) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
      renderScheduled = false;
      if (!assistantEl) return;
      const bodyEl = assistantEl.querySelector('.body');
      bodyEl.innerHTML = renderMarkdown(assistantText) || '<span class="thinking"></span>';
      decorateCode(bodyEl);
      const nearBottom = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 80;
      if (nearBottom || final) scrollToBottom();
    });
  }

  function setBusy(v) {
    busy = v;
    body.classList.toggle('busy', v);
    quick.querySelectorAll('button').forEach((b) => { b.disabled = v; });
    document.getElementById('btn-snap').classList.toggle('busy', v);
    refreshStatus();
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
    showView('chat');
    await api.ask({ action, smart: optSmart.checked });
  }

  api.onChatStart(({ id, question, withScreenshot }) => {
    activeId = id;
    assistantText = '';
    showView('chat');
    addUser(question, withScreenshot);
    assistantEl = addAssistant();
    setBusy(true);
  });

  api.onChatDelta(({ id, text }) => {
    if (id !== activeId) return;
    assistantText += text;
    scheduleRender(false);
  });

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
      if (assistantText) {
        const copy = document.createElement('button');
        copy.textContent = 'Copy answer';
        copy.addEventListener('click', async () => {
          await navigator.clipboard.writeText(assistantText);
          copy.textContent = 'Copied';
          setTimeout(() => { copy.textContent = 'Copy answer'; }, 1200);
        });
        meta.appendChild(copy);
      }
    }
    setBusy(false);
    assistantEl = null;
  });

  composer.addEventListener('submit', (e) => { e.preventDefault(); submitQuestion(input.value); });
  $('btn-stop').addEventListener('click', () => api.abort());

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(input.value); }
    if (e.key === 'Escape') { setMode('pill'); }
  });
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(120, input.scrollHeight)}px`;
  }
  input.addEventListener('input', autosize);

  quick.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (b) runAction(b.dataset.action);
  });

  optShot.addEventListener('change', () => api.setConfig({ attachScreenshot: optShot.checked }));

  // ---------- listening ----------
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

  async function toggleListen() {
    const btn = $('btn-listen');
    if (listener.active) {
      listener.stop();
      body.classList.remove('listening');
      btn.setAttribute('aria-pressed', 'false');
      refreshStatus();
      return;
    }
    if (cfg && !cfg.sttEnabled) { lastLine = 'transcription is off in settings'; refreshStatus(); return; }
    setStatus('Starting mic', '');
    const res = await listener.start();
    if (!listener.active) {
      lastLine = res.errors.join(' · ');
      refreshStatus();
      return;
    }
    body.classList.add('listening');
    btn.setAttribute('aria-pressed', 'true');
    lastLine = res.them ? '' : 'mic only (no system audio)';
    refreshStatus();
  }
  $('btn-listen').addEventListener('click', toggleListen);

  api.onTranscript((entry) => {
    transcriptCount += 1;
    lastLine = entry.text.length > 60 ? `${entry.text.slice(0, 60)}…` : entry.text;
    transcriptEmpty.style.display = 'none';
    const line = document.createElement('div');
    line.className = `tline ${entry.who}`;
    line.innerHTML = `<span class="who"></span><span class="text"></span>`;
    line.querySelector('.who').textContent = entry.who;
    line.querySelector('.text').textContent = entry.text;
    transcriptEl.appendChild(line);
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
    refreshStatus();
  });

  $('btn-clear-transcript').addEventListener('click', async () => {
    await api.clearTranscript();
    transcriptEl.querySelectorAll('.tline').forEach((n) => n.remove());
    transcriptEmpty.style.display = '';
    transcriptCount = 0;
    lastLine = '';
    refreshStatus();
  });

  // ---------- tooltips ----------
  // Not native `title` tooltips: this window is always-on-top at the 'screen-saver'
  // level, which sits above the OS tooltip layer, and in pill mode the window itself
  // is only ~44px tall with nowhere for a tooltip to draw anyway. So this positions a
  // bubble by hand and clamps it to the real window bounds (below the icon normally,
  // above it if there's no room below, and beside it if there's no room either way).
  const tip = document.createElement('div');
  tip.className = 'tip';
  document.body.appendChild(tip);

  function positionTip(el) {
    const r = el.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const margin = 6;
    let top = r.bottom + margin;
    let left = r.left + r.width / 2 - tr.width / 2;
    if (top + tr.height > window.innerHeight - 4) top = r.top - tr.height - margin;
    if (top < 4) {
      top = r.top + r.height / 2 - tr.height / 2;
      left = r.left - tr.width - margin;
      if (left < 4) left = r.right + margin;
    }
    left = Math.max(4, Math.min(left, window.innerWidth - tr.width - 4));
    top = Math.max(4, Math.min(top, window.innerHeight - tr.height - 4));
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function showTip(el) {
    const text = el.dataset.tip;
    if (!text) return;
    tip.textContent = text;
    tip.classList.add('show');
    positionTip(el);
  }
  function hideTip() { tip.classList.remove('show'); }

  document.querySelectorAll('[data-tip]').forEach((el) => {
    el.setAttribute('aria-label', el.dataset.tip);
    el.addEventListener('mouseenter', () => showTip(el));
    el.addEventListener('mouseleave', hideTip);
    el.addEventListener('mousedown', hideTip);
    el.addEventListener('focus', () => showTip(el));
    el.addEventListener('blur', hideTip);
  });

  // ---------- capsule + footer buttons ----------
  $('status').addEventListener('click', () => setMode(mode === 'pill' ? 'panel' : 'pill'));
  $('btn-expand').addEventListener('click', () => setMode(mode === 'pill' ? 'panel' : 'pill'));
  $('btn-snap').addEventListener('click', async () => {
    if (mode !== 'panel') await setMode('panel');
    showView('chat');
    optShot.checked = true;
    input.focus();
  });
  document.querySelectorAll('#sizes button').forEach((b) => b.addEventListener('click', () => setMode('panel', b.dataset.size)));
  $('btn-transcript').addEventListener('click', () => showView(view === 'transcript' ? 'chat' : 'transcript'));
  $('btn-settings').addEventListener('click', () => showView(view === 'settings' ? 'chat' : 'settings'));
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('btn-eye').addEventListener('click', async () => { cfg = await api.setConfig({ invisible: !cfg.invisible }); });
  $('btn-clear').addEventListener('click', async () => {
    await api.clearChat();
    messagesEl.querySelectorAll('.msg').forEach((n) => n.remove());
    emptyEl.style.display = '';
    input.focus();
  });
  $('btn-quit').addEventListener('click', () => api.quit());

  document.addEventListener('keydown', (e) => {
    const meta = e.metaKey || e.ctrlKey;
    if (meta && e.key === ',') { e.preventDefault(); showView(view === 'settings' ? 'chat' : 'settings'); }
    if (meta && e.key.toLowerCase() === 'k') { e.preventDefault(); $('btn-clear').click(); }
    if (e.key === 'Escape' && view !== 'chat') { showView('chat'); }
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
    f.sttModel.value = cfg.sttModel;
    f.sttBaseUrl.value = cfg.sttBaseUrl;
    f.chunkSeconds.value = cfg.chunkSeconds;
    f.invisible.checked = cfg.invisible;
    f.attachScreenshot.checked = cfg.attachScreenshot;
    f.systemPrompt.value = cfg.systemPrompt || '';
    refreshPermissions();
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
      sttModel: f.sttModel.value.trim(),
      sttBaseUrl: f.sttBaseUrl.value.trim() || 'https://api.openai.com/v1',
      chunkSeconds: Math.min(20, Math.max(3, Number(f.chunkSeconds.value) || 6)),
      invisible: f.invisible.checked,
      attachScreenshot: f.attachScreenshot.checked,
      systemPrompt: f.systemPrompt.value,
    };
    if (f.apiKey.value.trim()) patch.apiKey = f.apiKey.value.trim();
    if (f.anthropicApiKey.value.trim()) patch.anthropicApiKey = f.anthropicApiKey.value.trim();
    cfg = await api.setConfig(patch);
    optShot.checked = cfg.attachScreenshot;
    showView('chat');
  });

  async function refreshPermissions() {
    const p = await api.permissionStatus();
    $('perm-state').textContent = `mic: ${p.mic} · screen: ${p.screen}`;
  }
  $('btn-perms').addEventListener('click', async () => {
    const p = await api.requestPermissions();
    $('perm-state').textContent = `mic: ${p.mic} · screen: ${p.screen}` + (p.screen !== 'granted' ? ' — enable Pill under Screen Recording, then quit and reopen' : '');
  });

  // ---------- status from main ----------
  api.onStatus((s) => {
    if (cfg) cfg.invisible = s.invisible;
    body.classList.toggle('invisible', Boolean(s.invisible));
    const list = $('shortcut-list');
    list.innerHTML = '';
    const names = {
      toggle: 'Show / hide', expand: 'Expand / collapse', ask: 'Ask with screenshot', solve: 'Solve what is on screen',
      listen: 'Toggle listening', invisible: 'Toggle hidden from share', up: 'Move up', down: 'Move down', left: 'Move left', right: 'Move right', quit: 'Quit',
    };
    for (const [name, st] of Object.entries(s.shortcuts || {})) {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = names[name] || name;
      const kbd = document.createElement('kbd');
      const KEY_WORDS = { CommandOrControl: 'Command', Return: 'Enter' };
      kbd.textContent = st.accel.split('+').map((k) => KEY_WORDS[k] || k).join(' + ');
      if (!st.ok) { kbd.classList.add('taken'); kbd.title = 'Another app owns this shortcut'; }
      li.append(label, kbd);
      list.appendChild(li);
    }
  });

  api.onMode(({ mode: m, size }) => applyMode(m, size));
  api.onResizing((v) => body.classList.toggle('resizing', v));

  api.onCommand(async ({ cmd, withScreenshot }) => {
    if (cmd === 'focus-input') {
      showView('chat');
      if (withScreenshot) optShot.checked = true;
      input.focus();
    }
    if (cmd === 'toggle-listen') toggleListen();
  });

  // ---------- boot ----------
  (async () => {
    cfg = await api.getConfig();
    optShot.checked = cfg.attachScreenshot;
    applyMode(cfg.mode, cfg.panelSize);
    body.classList.toggle('invisible', Boolean(cfg.invisible));
    showView('chat');
    if (!cfg.chatReady) {
      await setMode('panel');
      showView('settings');
      setStatus('Pill', 'add an API key');
    } else {
      refreshStatus();
    }
  })();
})();
