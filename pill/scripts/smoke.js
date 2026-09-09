// Launch the app under a virtual display, drive it through pill -> panel -> settings,
// capture PNGs of each state, and print any renderer console errors. Exits non-zero on error.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', 'smoke-out');
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
  const shot = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(out, `${name}.png`), img.toPNG());
    console.log(`saved ${name}.png ${JSON.stringify(win.getBounds())}`);
  };
  await sleep(800);
  await shot('1-pill');
  // fake a saved key so boot goes to chat instead of settings
  await win.webContents.executeJavaScript(`window.pill.setConfig({apiKey:'sk-test-1234567890abcdef', anthropicApiKey:'sk-ant-test-1234567890'})`);
  await win.webContents.executeJavaScript(`window.pill.setMode('panel','M')`); await sleep(300); await win.webContents.executeJavaScript(`document.querySelector('#view-settings [data-view=chat]').click()`);
  await sleep(600);
  await win.webContents.executeJavaScript(`(function(){ const el=document.getElementById('messages'); const e=document.getElementById('empty'); e.style.display='none';
    const u=document.createElement('div'); u.className='msg msg-user'; u.textContent='write a python function that reverses a linked list'; const t=document.createElement('span'); t.className='tag'; t.textContent='screenshot'; u.appendChild(t); el.appendChild(u);
    const a=document.createElement('div'); a.className='msg msg-assistant'; a.innerHTML='<div class="body"></div><div class="msg-meta"><span>gpt-5.6-luna</span><button>Copy answer</button></div>';
    const md='Iterate once, flipping each node\\'s pointer.\\n\\n\\x60\\x60\\x60python\\ndef reverse(head):\\n    prev = None\\n    while head:\\n        head.next, prev, head = prev, head, head.next\\n    return prev\\n\\x60\\x60\\x60\\n\\n- **Time** O(n), **space** O(1)\\n- Works for empty list and single node';
    a.querySelector('.body').innerHTML = DOMPurify.sanitize(marked.parse(md)); a.querySelectorAll('pre code').forEach(c=>hljs.highlightElement(c)); el.appendChild(a);
    document.getElementById('status-main').textContent='Listening'; document.getElementById('status-sub').textContent='· so what is the time complexity of that';
    document.body.classList.add('listening');
  })()`);
  await sleep(400);
  await shot('2-panel-chat');
  await win.webContents.executeJavaScript(`document.getElementById('btn-settings').click()`);
  await sleep(400);
  await shot('3-panel-settings');
  await win.webContents.executeJavaScript(`window.pill.setMode('pill')`);
  await sleep(600);
  await shot('4-pill-again');
  console.log(errors ? `DONE with ${errors} renderer error(s)` : 'DONE clean');
  app.exit(errors ? 1 : 0);
});
