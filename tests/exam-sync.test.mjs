import assert from 'node:assert/strict';
import { decryptSyncSession, encryptSyncSession, examSourceKey, examTimestamp, fetchCurrentExams } from '../src/exam-sync.js';

const env = {
  SYNC_SESSION_SECRET: 'abcdef0123456789'.repeat(4),
  UPSTREAM_ORIGIN: 'https://jwgl.xaut.edu.cn'
};

const original = { cookies: { bzb_jsxsd: 'SESSION_OK', route: 'A' }, capturedAt: 123 };
const encrypted = await encryptSyncSession(original, env);
assert.doesNotMatch(encrypted, /SESSION_OK/);
assert.deepEqual(await decryptSyncSession(encrypted, env), original);

let requestCount = 0;
globalThis.fetch = async input => {
  requestCount++;
  const url = new URL(input);
  if (url.pathname.endsWith('/xsksap_query')) {
    return new Response(`<select id="xnxqid"><option value="2026-2027-1" selected>2026-2027-1</option></select>`, {
      headers: { 'Set-Cookie': 'route=B; Path=/' }
    });
  }
  if (url.pathname.endsWith('/xsksap_list')) {
    return new Response(JSON.stringify({ code: 0, count: 1, data: [{
      xnxqid: '2026-2027-1', kch: 'C001', kskcmc: '数字电路', kssj: '2026-12-20 08:30-10:30',
      js_mc: '综南224', ksxq: '曲江校区', zwh: '18'
    }] }), { headers: { 'Content-Type': 'application/json' } });
  }
  throw new Error(`Unexpected URL ${url}`);
};

const fetched = await fetchCurrentExams(original, env);
assert.equal(requestCount, 2);
assert.equal(fetched.selectedTerm, '2026-2027-1');
assert.equal(fetched.items[0].name, '数字电路');
assert.equal(fetched.session.cookies.route, 'B');
assert.equal(examSourceKey(fetched.items[0]), '2026-2027-1|c001|数字电路');
assert.equal(examTimestamp(fetched.items[0]), Date.parse('2026-12-20T08:30:00+08:00'));

globalThis.fetch = async () => new Response('<form id="loginForm"><input name="USERNAME"><input name="PASSWORD">验证码</form>');
await assert.rejects(() => fetchCurrentExams(original, env), error => error?.name === 'SessionExpiredError');

console.log('Exam sync tests passed: encryption, cookie refresh, JSON parsing, timestamp and expired-session detection');
