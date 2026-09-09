// Launch the app under a virtual display, drive it through pill -> panel -> tabs,
// capture PNGs of each state, and print any renderer console errors. Exits non-zero on error.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'smoke-out');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(out, 'userData'));
let errors = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

require('../main.js');

app.whenReady().then(async () => {
  await sleep(1500);
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) { console.error('no window'); process.exit(1); }
  win.webContents.on('console-message', (_e, level, msg) => {
    console.log(`[renderer:${level}] ${msg}`);
    if (level >= 2) errors++;
  });
  const js = (code) => win.webContents.executeJavaScript(code);
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    console.log(`saved ${name}.png ${JSON.stringify(win.getBounds())}`);
  };
  await sleep(800);
  await shot('1-first-run-settings');

  // Pretend keys exist and go to the chat tab
  await js(`window.pill.setConfig({apiKey:'sk-test-1234567890abcdef', anthropicApiKey:'sk-ant-test-1234567890'})`);
  await js(`window.pill.setMode('panel','M')`);
  await sleep(300);
  await js(`document.querySelector('#tabs [data-tab=chat]').click()`);
  await sleep(200);
  await shot('2-chat-empty');

  // Simulate a recording session with transcript lines coming from main
  const session = { id: '2026-09-03_14-05', startedAt: Date.now() - 754000, title: '' };
  win.webContents.send('transcript:reset', { session, entries: [] });
  const linesIn = [
    ['them', 'So walk me through how you would reverse a linked list in place.'],
    ['me', 'Sure, so I would keep a previous pointer and iterate once.'],
    ['them', 'And what is the time complexity of that?'],
  ];
  for (const [who, text] of linesIn) { win.webContents.send('transcript:add', { t: Date.now(), who, text }); await sleep(50); }
  await js(`document.body.classList.add('recording'); document.getElementById('rec-label').textContent='12:34'; document.getElementById('status-main').textContent='Recording'; document.getElementById('status-sub').textContent='· And what is the time complexity of that?'`);
  await sleep(200);

  // Simulate a chat exchange
  win.webContents.send('chat:start', { id: 1, question: 'Answer what was just asked', withScreenshot: true });
  await sleep(100);
  const md = 'It\'s **O(n)** time and **O(1)** extra space: one pass, three pointers, no allocation.\n\n```python\ndef reverse(head):\n    prev = None\n    while head:\n        head.next, prev, head = prev, head, head.next\n    return prev\n```\n\nIf they push: recursion is also O(n) but uses O(n) stack, so iterative is the one to give.';
  for (const piece of md.match(/[\s\S]{1,40}/g)) { win.webContents.send('chat:delta', { id: 1, text: piece }); await sleep(10); }
  win.webContents.send('chat:done', { id: 1, text: md, model: 'claude-sonnet-5' });
  await sleep(400);
  await shot('3-chat-answer');

  await js(`document.querySelector('#tabs [data-tab=transcript]').click()`);
  await sleep(200);
  await shot('4-transcript');

  // Refinement flow: progress banner, then the refined speaker-labelled transcript
  win.webContents.send('refine:progress', { sessionId: session.id, stage: 'transcribing' });
  await sleep(250);
  await shot('4b-refining');
  const refined = {
    session: {
      id: session.id, startedAt: session.startedAt, title: '', lines: 5, refined: true,
      speakers: [
        { key: '1', name: 'Gareth', uid: 'uid-g', similarity: 0.82, seconds: 214, embedding: [0.8, 0.1] },
        { key: '2', name: 'Speaker 1', uid: null, similarity: 0, seconds: 37, embedding: [0.1, 0.9] },
      ],
    },
    entries: [
      { t: Date.now() - 60000, who: 'them', text: 'So walk me through how you would reverse a linked list in place.', key: '1', name: 'Gareth' },
      { t: Date.now() - 52000, who: 'me', text: 'Sure, so I would keep a previous pointer and iterate once.', key: 'me', name: 'me' },
      { t: Date.now() - 40000, who: 'them', text: 'And what is the time complexity of that?', key: '1', name: 'Gareth' },
      { t: Date.now() - 30000, who: 'me', text: 'O of n time, O of 1 space.', key: 'me', name: 'me' },
      { t: Date.now() - 20000, who: 'them', text: 'Nice, that is exactly right.', key: '2', name: 'Speaker 1' },
    ],
  };
  win.webContents.send('transcript:reset', refined);
  await sleep(150);
  win.webContents.send('refine:done', { sessionId: session.id, stats: { voices: 2, matched: 1 }, seconds: 21 });
  await sleep(250);
  await shot('4c-refined-speakers');

  // Click the unnamed chip -> rename input appears
  await js(`[...document.querySelectorAll('.speaker-chip')].find((c) => c.textContent.includes('name?')).click()`);
  await sleep(150);
  await js(`document.querySelector('.chip-input').value = 'Karthik'`);
  await shot('4d-naming-speaker');
  await js(`document.querySelector('.chip-input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(100);

  // Notes streaming
  await js(`document.querySelector('#tabs [data-tab=notes]').click()`);
  await sleep(200);
  win.webContents.send('notes:start', { sessionId: session.id });
  const notes = '# Linked list interview practice\n\n**Summary** — A mock technical interview. They asked for an in-place linked list reversal and its complexity; I gave the iterative three-pointer approach.\n\n## Key points\n- Iterative reversal with prev/curr/next pointers\n- O(n) time, O(1) space\n\n## Action items\n- [ ] Practise the recursive variant and its stack cost — me\n\n## Open questions\n- Whether they wanted the doubly-linked variant too';
  for (const piece of notes.match(/[\s\S]{1,50}/g)) { win.webContents.send('notes:delta', { sessionId: session.id, text: piece }); await sleep(10); }
  win.webContents.send('notes:done', { sessionId: session.id, text: notes, file: '/tmp/x.md' });
  await sleep(400);
  await shot('5-notes');

  // Dashboard search
  await js(`document.getElementById('session-search').value = 'zzz-no-match'; document.getElementById('session-search').dispatchEvent(new Event('input'))`);
  await sleep(150);
  await js(`document.getElementById('session-search').value = ''; document.getElementById('session-search').dispatchEvent(new Event('input'))`);
  await sleep(150);

  await js(`document.querySelector('#tabs [data-tab=settings]').click()`);
  await sleep(300);
  await js(`document.querySelector('.settings').scrollTop = 9999`);
  await sleep(150);
  await shot('6-settings');

  // Shortcuts editor: capture Control+Alt+M for 'record'
  await js(`[...document.querySelectorAll('#shortcut-list .accel')][4].click()`);
  await sleep(100);
  await shot('6b-shortcut-capturing');
  await js(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'm', ctrlKey: true, altKey: true, bubbles: true, cancelable: true }))`);
  await sleep(300);
  const recAccel = await js(`window.pill.getConfig().then((c) => c.shortcuts.record)`);
  if (recAccel !== 'Control+Alt+M') { console.error(`shortcut capture failed: ${recAccel}`); errors++; }
  await shot('6c-shortcut-changed');

  await js(`window.pill.setMode('pill')`);
  await sleep(600);
  await shot('7-pill-recording');
  console.log(errors ? `DONE with ${errors} renderer error(s)` : 'DONE clean');
  app.exit(errors ? 1 : 0);
});
