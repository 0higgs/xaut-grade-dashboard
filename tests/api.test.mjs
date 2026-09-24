import assert from 'node:assert/strict';
import fs from 'node:fs';

const functionCode = fs.readFileSync(new URL('../functions/api/[[path]].js', import.meta.url), 'utf8');
const { onRequest } = await import(`data:text/javascript;base64,${Buffer.from(functionCode).toString('base64')}`);

const env = {
  SESSION_SECRET: '0123456789abcdef'.repeat(4),
  UPSTREAM_ORIGIN: 'http://jwgl.xaut.edu.cn'
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
  if (path === '/jsxsd/xskb/xskb_list.do') {
    const term = new URLSearchParams(String(options.body || '')).get('xnxq01id') || '2024-2025-1';
    return upstreamResponse(`<select id="xnxq01id" name="xnxq01id">
      <option value="2024-2025-1" ${term === '2024-2025-1' ? 'selected' : ''}>2024-2025-1</option>
      <option value="2024-2025-2" ${term === '2024-2025-2' ? 'selected' : ''}>2024-2025-2</option>
    </select><table id="kbtable"><tr><th>节次</th><th>星期一</th><th>星期二</th></tr><tr><td>第一节</td><td>高等数学<br>1-16周<br>A101</td><td></td></tr></table><table><tr><th>备注</th></tr><tr><td>未排课课程：大学生劳动教育</td></tr></table>`);
  }
  if (path === '/jsxsd/framework/xsdPerson_10700.htmlx') {
    return upstreamResponse(`<input id="xzrq" value="2026-09-24">
      <span id="showzc">第1周/26周</span><select id="xkzc"><option value="1">第1周</option><option value="26">第26周</option></select>
      <div class="table-body">
        <ul><li class="row-one"><h5>第一大节</h5><span>08:00～09:50</span></li></ul>
        <ul><li class="row-one"><h5>第二大节</h5><span>10:10～12:00</span></li></ul>
        <div class="table-class div-context day3 xqcolor0" style="height: calc(1 * 95px - 4px);top: calc((0 * 95px) + 2px);">
          <h4>概率论与数理统计</h4><ul><li>周次:第2-12周</li><li>地点:综南220</li><li>教师:肖燕婷</li></ul>
          <div class="suspension-table-class"><p>学分：3学分</p><p>课程性质：专业基础课</p><p>节次：01-02节</p><p>班级：电子H班</p></div>
        </div>
      </div><script>var dqzc = '4';</script>`);
  }
  throw new Error(`Unexpected upstream request: ${options.method || 'GET'} ${url}`);
};

function context(path, method = 'GET', { cookie = '', body, origin = 'https://grades.pages.dev', query = '' } = {}) {
  const url = `https://grades.pages.dev/api/${path}${query}`;
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

const schedule = await onRequest(context('schedule', 'GET', { cookie: cookiePair(grades), query: '?term=2024-2025-2' }));
assert.equal(schedule.status, 200);
const scheduleData = await schedule.json();
assert.equal(scheduleData.ok, true);
assert.deepEqual(scheduleData.terms, ['2024-2025-1', '2024-2025-2']);
assert.equal(scheduleData.selectedTerm, '2024-2025-2');
assert.equal(scheduleData.tables.length, 2);
assert.match(scheduleData.tables[0], /星期一/);
assert.match(scheduleData.page, /id="kbtable"/);

const weekSchedule = await onRequest(context('week-schedule', 'GET', { cookie: cookiePair(schedule) }));
assert.equal(weekSchedule.status, 200);
const weekScheduleData = await weekSchedule.json();
assert.equal(weekScheduleData.currentWeek, 4);
assert.equal(weekScheduleData.totalWeeks, 26);
assert.deepEqual(weekScheduleData.dates, ['2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24', '2026-09-25', '2026-09-26', '2026-09-27']);
assert.equal(weekScheduleData.events.length, 1);
assert.deepEqual(weekScheduleData.events[0], {
  name: '概率论与数理统计', teacher: '肖燕婷', room: '综南220', weeks: '第2-12周', sections: '01-02节',
  className: '电子H班', nature: '专业基础课', credit: '3学分', dayIndex: 3, date: '2026-09-24',
  slotLabel: '第一大节', startTime: '08:00', endTime: '09:50'
});

const logout = await onRequest(context('logout', 'POST', { cookie: cookiePair(weekSchedule) }));
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

const forbiddenPlaintextOrigin = await onRequest({
  ...context('captcha'),
  env: { ...env, UPSTREAM_ORIGIN: 'http://evil.example' }
});
assert.equal(forbiddenPlaintextOrigin.status, 500);
assert.match((await forbiddenPlaintextOrigin.json()).error, /临时 HTTP 仅允许学校官方教务域名/);

console.log('API tests passed: captcha, encrypted session, login, grades, semester and official weekly schedules, logout, errors, origin check');
