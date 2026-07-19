import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../public', import.meta.url)));
const port = 9877;
const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'grade-dump-test-'));

const tables = [
  ['2024-2025-1', '高等数学', '88', '3', '3.8'],
  ['2024-2025-2', '大学物理', '92', '4', '4.2']
].map(([term, name, score, credit, gpa]) => `<table id="dataList"><tr><th>开课学期</th><th>课程编号</th><th>课程名称</th><th>成绩</th><th>学分</th><th>绩点</th></tr><tr><td>${term}</td><td>C001</td><td>${name}</td><td>${score}</td><td>${credit}</td><td>${gpa}</td></tr></table>`);

const injectedTest = `<script>
(()=>{
  const result=document.createElement('pre');result.id='browser-test-result';document.body.appendChild(result);
  document.querySelector('#loginBtn').click();
  document.querySelector('#loginAccount').value='20250001';
  document.querySelector('#loginPassword').value='secret';
  document.querySelector('#loginCaptcha').value='ABCD';
  document.querySelector('#directLoginForm').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));
  let attempts=0;
  const timer=setInterval(()=>{
    const rows=document.querySelectorAll('#gradeBody tr').length;
    const scheduleRows=document.querySelectorAll('#scheduleTableWrap .schedule-table tr').length;
    if(rows===2&&scheduleRows===2){
      clearInterval(timer);
      document.querySelector('.mobile-nav [data-view="schedule"]').click();
      const scheduleDisplay=getComputedStyle(document.querySelector('#scheduleView')).display;
      document.querySelector('.mobile-nav [data-view="analysis"]').click();
      const values=[rows,document.querySelectorAll('#yearFilter option').length,getComputedStyle(document.querySelector('.mobile-nav')).display,scheduleDisplay,scheduleRows,getComputedStyle(document.querySelector('#analysisView')).display,document.querySelectorAll('#analysisBody tr').length,document.documentElement.scrollWidth<=window.innerWidth];
      document.querySelector('#logoutBtn').click();
      setTimeout(()=>{values.push(document.querySelector('#loginBtn').hidden,document.querySelector('#logoutBtn').hidden);result.textContent='PASS|'+values.join('|')},150);
    }else if(++attempts>40){clearInterval(timer);result.textContent='FAIL|rows='+rows+'|progress='+document.querySelector('#loginProgress').textContent}
  },100);
})();
</script>`;

const server = http.createServer(async (req, res) => {
  if (req.url.startsWith('/api/captcha')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="132" height="42"><rect width="100%" height="100%" fill="#eef2ff"/><text x="35" y="27" font-size="18">ABCD</text></svg>');
    return;
  }
  if (req.url === '/api/login' && req.method === 'POST') {
    for await (const _chunk of req) { /* consume without logging credentials */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/api/grades') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, terms: ['2024-2025-1', '2024-2025-2'], pages: tables.map((table, index) => ({ term: `2024-2025-${index + 1}`, table })) }));
    return;
  }
  if (req.url.startsWith('/api/schedule')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, terms: ['2024-2025-1', '2024-2025-2'], selectedTerm: '2024-2025-2', tables: ['<table id="kbtable"><tr><th>节次</th><th>星期一</th><th>星期二</th></tr><tr><td>第一节</td><td>高等数学<br>1-16周<br>A101</td><td></td></tr></table>'] }));
    return;
  }
  if (req.url === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('</body>', `${injectedTest}</body>`);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }
  res.writeHead(404); res.end('Not found');
});

await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));

try {
  const chrome = spawn(chromePath, [
    '--headless=new', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-shader-disk-cache',
    '--disable-features=SkiaGraphite,Vulkan,DawnGraphiteCache,UseSkiaRenderer', '--no-first-run',
    `--user-data-dir=${profile}`, '--window-size=390,844',
    '--virtual-time-budget=6000', '--dump-dom', `http://127.0.0.1:${port}/`
  ], { windowsHide: true });
  let output = '', errors = '';
  chrome.stdout.setEncoding('utf8');
  chrome.stderr.setEncoding('utf8');
  chrome.stdout.on('data', chunk => { output += chunk; });
  chrome.stderr.on('data', chunk => { errors += chunk; });
  const exitCode = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { chrome.kill('SIGKILL'); reject(new Error('Chrome browser test timed out')); }, 15000);
    chrome.on('close', code => { clearTimeout(timeout); resolve(code); });
    chrome.on('error', reject);
  });
  assert.equal(exitCode, 0, errors);
  const match = output.match(/<pre id="browser-test-result">([^<]+)<\/pre>/);
  assert.ok(match, 'Browser test did not produce a result');
  assert.equal(match[1], 'PASS|2|2|flex|block|2|block|2|true|false|true');
  console.log('Browser tests passed: direct login, grades, timetable, term filter, mobile navigation, analysis, logout');
} finally {
  server.closeAllConnections?.();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
