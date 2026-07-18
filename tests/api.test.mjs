import assert from 'node:assert/strict';
import fs from 'node:fs';

const functionCode = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(functionCode).toString('base64')}`);

const env = {
  SESSION_SECRET: '0123456789abcdef'.repeat(4),
  UPSTREAM_ORIGIN: 'https://jwgl.xaut.edu.cn'
};
let loginShouldFail = false;
let lastLoginBody = '';

function upstreamResponse(body = '', options = {}) {
  const headers = new Headers(options.headers || {});
  for (const cookie of options.cookies || []) headers.append('Set-Cookie', cookie);
  return new Response(body, { status: options.status || 200, headers });
}

globalThis.fetch = async (input, options = {}) => {
  const url = new URL(input);
  const path = url.pathname;
  if (path === '/jsxsd/') {
    return upstreamResponse('<html>login</html>', {
      cookies: [
        'bzb_jsxsd=SESSION_A; Path=/jsxsd; HttpOnly',
        'X-LB=LB_A; Expires=Sun, 19 Jul 2026 11:04:27 GMT; Path=/'
      ]
    });
  }
  if (path === '/jsxsd/verifycode.servlet') {
    return upstreamResponse(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]), {
      headers: { 'Content-Type': 'image/jpeg' }
    });
  }
  if (path === '/jsxsd/xk/LoginToXk') {
    lastLoginBody = String(options.body || '');
    if (loginShouldFail) {
      return upstreamResponse('<form id="loginForm"><font id="showMsg">验证码错误!!</font></form>');
    }
    return upstreamResponse('<html><body>个人中心</body></html>', {
      cookies: ['bzb_jsxsd=SESSION_LOGGED_IN; Path=/jsxsd; HttpOnly']
    });
  }
  if (path === '/jsxsd/kscj/cjcx_frm') {
    return upstreamResponse(`<select name="kksj">
      <option value="2024-2025-1">2024-2025-1</option>
      <option value="2024-2025-2">2024-2025-2</option>
    </select>`);
  }
  if (path === '/jsxsd/kscj/cjcx_list') {
    const term = new URLSearchParams(String(options.body || '')).get('kksj') || '2024-2025-1';
    const course = term.endsWith('-1') ? '高等数学' : '大学物理';
    return upstreamResponse(`<table id="dataList"><tr><th>开课学期</th><th>课程编号</th><th>课程名称</th><th>成绩</th><th>学分</th><th>绩点</th></tr><tr><td>${term}</td><td>C001</td><td>${course}</td><td>88</td><td>3</td><td>3.8</td></tr></table>`);
  }
  throw new Error(`Unexpected upstream request: ${options.method || 'GET'} ${url}`);
};

function context(path, method = 'GET', { cookie = '', body, origin = 'https://grades.pages.dev' } = {}) {
  const url = `https://grades.pages.dev/api/${path}`;
  const headers = new Headers();
  if (cookie) headers.set('Cookie', cookie);
  if (origin) headers.set('Origin', origin);
  if (body !== undefined) headers.set('Content-Type', 'application/json');
  return {
    request: new Request(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }),
    env,
    params: { path: [path] }
  };
}

function cookiePair(response) {
  return response.headers.get('set-cookie').split(';', 1)[0];
}

const captcha = await onRequest(context('captcha'));
assert.equal(captcha.status, 200);
assert.equal(captcha.headers.get('content-type'), 'image/jpeg');
assert.equal((await captcha.arrayBuffer()).byteLength, 4);
const captchaCookie = cookiePair(captcha);
assert.match(captchaCookie, /^xaut_grade_session=/);

const login = await onRequest(context('login', 'POST', {
  cookie: captchaCookie,
  body: { account: '20250001', password: 'secret123', captcha: 'ABCD' }
}));
assert.equal(login.status, 200);
assert.deepEqual(await login.json(), { ok: true });
assert.equal(new URLSearchParams(lastLoginBody).get('encoded'), `${Buffer.from('20250001').toString('base64')}%%%${Buffer.from('secret123').toString('base64')}`);
const loginCookie = cookiePair(login);

const grades = await onRequest(context('grades', 'GET', { cookie: loginCookie }));
assert.equal(grades.status, 200);
const gradeData = await grades.json();
assert.equal(gradeData.ok, true);
assert.deepEqual(gradeData.terms, ['2024-2025-1', '2024-2025-2']);
assert.equal(gradeData.pages.length, 2);
assert.match(gradeData.pages[0].table, /课程名称/);

const logout = await onRequest(context('logout', 'POST', { cookie: cookiePair(grades) }));
assert.equal(logout.status, 200);
assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);

loginShouldFail = true;
const secondCaptcha = await onRequest(context('captcha'));
const failedLogin = await onRequest(context('login', 'POST', {
  cookie: cookiePair(secondCaptcha),
  body: { account: '20250001', password: 'wrong', captcha: '0000' }
}));
assert.equal(failedLogin.status, 401);
assert.match((await failedLogin.json()).error, /验证码错误/);

const crossOrigin = await onRequest(context('login', 'POST', {
  cookie: captchaCookie,
  origin: 'https://evil.example',
  body: { account: 'a', password: 'b', captcha: 'c' }
}));
assert.equal(crossOrigin.status, 403);

console.log('API tests passed: captcha, encrypted session, login, all terms, logout, errors, origin check');
