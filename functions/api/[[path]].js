const DEFAULT_UPSTREAM = 'https://jwgl.xaut.edu.cn';
const SESSION_COOKIE = 'xaut_grade_session';
const SESSION_TTL_SECONDS = 15 * 60;
const MAX_TERMS = 30;
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const SESSION_AAD = new TextEncoder().encode('xaut-grade-session-v1');

export async function onRequest(context) {
  const { request, env, params } = context;
  const pathParts = Array.isArray(params.path) ? params.path : [params.path].filter(Boolean);
  const action = pathParts.join('/');

  try {
    if (!env.SESSION_SECRET) {
      throw httpError(500, '服务尚未配置 SESSION_SECRET');
    }

    if (action === 'captcha' && request.method === 'GET') {
      return await handleCaptcha(request, env);
    }
    if (action === 'login' && request.method === 'POST') {
      assertSameOrigin(request);
      return await handleLogin(request, env);
    }
    if (action === 'grades' && request.method === 'GET') {
      return await handleGrades(request, env);
    }
    if (action === 'schedule' && request.method === 'GET') {
      return await handleSchedule(request, env);
    }
    if (action === 'logout' && request.method === 'POST') {
      assertSameOrigin(request);
      return jsonResponse({ ok: true }, 200, {
        'Set-Cookie': clearSessionCookie(request)
      });
    }

    return jsonResponse({ ok: false, error: '接口不存在' }, 404);
  } catch (error) {
    const status = Number(error?.status) || 500;
    const safeMessage = status >= 500 && !error?.expose
      ? '服务暂时不可用，请稍后重试'
      : String(error?.message || '请求失败');
    return jsonResponse({ ok: false, error: safeMessage }, status);
  }
}

async function handleCaptcha(request, env) {
  const jar = {};
  await upstreamRequest('/jsxsd/', { method: 'GET' }, jar, env);
  const captcha = await upstreamRequest(
    `/jsxsd/verifycode.servlet?t=${Date.now()}`,
    { method: 'GET', headers: { Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' } },
    jar,
    env
  );
  const token = await encryptSession({ cookies: jar, exp: Date.now() + SESSION_TTL_SECONDS * 1000 }, env);
  const headers = new Headers();
  headers.set('Content-Type', captcha.response.headers.get('content-type') || 'image/jpeg');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Set-Cookie', sessionCookie(token, request));
  return new Response(captcha.body, { status: 200, headers });
}

async function handleLogin(request, env) {
  const state = await requireSession(request, env);
  const input = await readJson(request);
  const account = validateText(input.account, '账号', 1, 64);
  const password = validateText(input.password, '密码', 1, 128);
  const captcha = validateText(input.captcha, '验证码', 1, 12);
  const encoded = `${officialBase64(account)}%%%${officialBase64(password)}`;
  const body = new URLSearchParams({
    userAccount: account,
    userPassword: password,
    RANDOMCODE: captcha,
    encoded
  });

  const result = await upstreamRequest('/jsxsd/xk/LoginToXk', {
    method: 'POST',
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
      Referer: `${upstreamOrigin(env)}/jsxsd/`
    },
    body: body.toString()
  }, state.cookies, env);

  const html = await result.text();
  if (isLoginPage(html)) {
    const message = extractLoginMessage(html) || '登录失败，请检查账号、密码和验证码';
    throw httpError(401, message);
  }

  const token = await encryptSession({
    cookies: state.cookies,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  }, env);
  return jsonResponse({ ok: true }, 200, {
    'Set-Cookie': sessionCookie(token, request)
  });
}

async function handleGrades(request, env) {
  const state = await requireSession(request, env);
  const formResult = await upstreamRequest('/jsxsd/kscj/cjcx_frm', {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml' }
  }, state.cookies, env);
  const formHtml = await formResult.text();
  if (isLoginPage(formHtml)) throw httpError(401, '登录会话已失效，请重新登录');

  const discoveredTerms = parseAcademicTerms(formHtml).slice(0, MAX_TERMS);
  const targets = discoveredTerms.length ? discoveredTerms : [''];
  const pages = [];

  for (let index = 0; index < targets.length; index += 3) {
    const batch = targets.slice(index, index + 3);
    const results = await Promise.all(batch.map(async term => {
      const body = new URLSearchParams({ kksj: term, kcxz: '', kcmc: '', xsfs: 'all' });
      const result = await upstreamRequest('/jsxsd/kscj/cjcx_list', {
        method: 'POST',
        headers: {
          Accept: 'text/html,application/xhtml+xml',
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          Referer: `${upstreamOrigin(env)}/jsxsd/kscj/cjcx_frm`
        },
        body: body.toString()
      }, state.cookies, env);
      const html = await result.text();
      if (isLoginPage(html)) throw httpError(401, '登录会话已失效，请重新登录');
      return { term, table: findGradeTable(html) };
    }));
    for (const result of results) {
      if (result.table) pages.push(result);
    }
  }

  if (!pages.length) {
    const fallback = await upstreamRequest('/jsxsd/kscj/cjcx_list', {
      method: 'GET', headers: { Accept: 'text/html,application/xhtml+xml' }
    }, state.cookies, env);
    const html = await fallback.text();
    const table = findGradeTable(html);
    if (table) pages.push({ term: '', table });
  }

  const token = await encryptSession({
    cookies: state.cookies,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  }, env);
  return jsonResponse({ ok: true, terms: discoveredTerms, pages }, 200, {
    'Set-Cookie': sessionCookie(token, request)
  });
}

async function handleSchedule(request, env) {
  const state = await requireSession(request, env);
  const requestedTerm = new URL(request.url).searchParams.get('term')?.trim() || '';
  if (requestedTerm && !/^20\d{2}-20\d{2}-[123]$/.test(requestedTerm)) {
    throw httpError(400, '学期格式无效');
  }

  const schedulePath = '/jsxsd/xskb/xskb_list.do';
  const firstResult = await upstreamRequest(schedulePath, {
    method: 'GET',
    headers: { Accept: 'text/html,application/xhtml+xml' }
  }, state.cookies, env);
  let html = await firstResult.text();
  if (isLoginPage(html)) throw httpError(401, '登录会话已失效，请重新登录');

  const terms = parseScheduleTerms(html).slice(0, MAX_TERMS);
  if (requestedTerm && terms.length && !terms.includes(requestedTerm)) {
    throw httpError(400, '所选学期不在教务系统可用范围内');
  }
  const selectedFromPage = parseSelectedScheduleTerm(html);
  const selectedTerm = requestedTerm || selectedFromPage || terms[0] || '';

  if (selectedTerm && selectedTerm !== selectedFromPage) {
    const body = new URLSearchParams({ xnxq01id: selectedTerm });
    const result = await upstreamRequest(schedulePath, {
      method: 'POST',
      headers: {
        Accept: 'text/html,application/xhtml+xml',
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        Referer: `${upstreamOrigin(env)}${schedulePath}`
      },
      body: body.toString()
    }, state.cookies, env);
    html = await result.text();
    if (isLoginPage(html)) throw httpError(401, '登录会话已失效，请重新登录');
  }

  const tables = findScheduleTables(html);
  const token = await encryptSession({
    cookies: state.cookies,
    exp: Date.now() + SESSION_TTL_SECONDS * 1000
  }, env);
  return jsonResponse({ ok: true, terms, selectedTerm, tables, page: html }, 200, {
    'Set-Cookie': sessionCookie(token, request)
  });
}

async function upstreamRequest(path, options, jar, env) {
  let url = new URL(path, upstreamOrigin(env));
  let method = options.method || 'GET';
  let body = options.body;
  let headers = new Headers(options.headers || {});

  for (let redirects = 0; redirects <= 5; redirects++) {
    headers.set('User-Agent', 'Mozilla/5.0 (compatible; XAUT-Grade-Dashboard/1.0)');
    headers.set('Cookie', serializeCookieJar(jar));
    const response = await fetch(url.toString(), {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      cache: 'no-store',
      signal: AbortSignal.timeout(20000)
    });
    mergeResponseCookies(jar, response.headers);

    if (![301, 302, 303, 307, 308].includes(response.status)) {
      const responseBody = await readResponseBody(response);
      if (!response.ok) throw httpError(502, `教务系统返回 HTTP ${response.status}`, false);
      return {
        response,
        body: responseBody,
        text: () => new TextDecoder('utf-8').decode(responseBody)
      };
    }

    const location = response.headers.get('location');
    if (!location) throw httpError(502, '教务系统返回了无效跳转', false);
    const next = new URL(location, url);
    if (next.origin !== upstreamOrigin(env)) throw httpError(502, '教务系统跳转到了非预期域名', false);
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = undefined;
      headers = new Headers({ Accept: headers.get('Accept') || 'text/html' });
    }
    url = next;
  }
  throw httpError(502, '教务系统跳转次数过多', false);
}

async function readResponseBody(response) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_UPSTREAM_BYTES) {
    throw httpError(502, '教务系统返回内容过大', false);
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_UPSTREAM_BYTES) {
      await reader.cancel();
      throw httpError(502, '教务系统返回内容过大', false);
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function parseAcademicTerms(html) {
  const select = html.match(/<select\b[^>]*(?:name|id)=["']kksj["'][^>]*>[\s\S]*?<\/select>/i)?.[0] || '';
  const terms = [];
  for (const match of select.matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>/gi)) {
    const value = decodeHtml(match[1]).trim();
    if (/^20\d{2}\D+20\d{2}\D+[123]$/.test(value) && !terms.includes(value)) terms.push(value);
  }
  return terms;
}

function parseScheduleTerms(html) {
  const select = html.match(/<select\b[^>]*(?:name|id)=["']xnxq01id["'][^>]*>[\s\S]*?<\/select>/i)?.[0] || '';
  const terms = [];
  for (const match of select.matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>/gi)) {
    const value = decodeHtml(match[1]).trim();
    if (/^20\d{2}-20\d{2}-[123]$/.test(value) && !terms.includes(value)) terms.push(value);
  }
  return terms;
}

function parseSelectedScheduleTerm(html) {
  const select = html.match(/<select\b[^>]*(?:name|id)=["']xnxq01id["'][^>]*>[\s\S]*?<\/select>/i)?.[0] || '';
  const selected = select.match(/<option\b[^>]*value=["']([^"']+)["'][^>]*\bselected(?:=["'][^"']*["'])?[^>]*>/i)?.[1]
    || select.match(/<option\b[^>]*\bselected(?:=["'][^"']*["'])?[^>]*value=["']([^"']+)["'][^>]*>/i)?.[1]
    || '';
  return decodeHtml(selected).trim();
}

function findScheduleTables(html) {
  const matches = [];
  for (const match of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const table = match[0];
    const text = decodeHtml(table.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
    const isTimetable = /星期[一二三四五六日天]|周[一二三四五六日天]/.test(text)
      && /节次|上午|下午|晚上|课程/.test(text);
    const isNoteTable = /备注/.test(text) && /课程|教学班|上课/.test(text);
    if ((isTimetable || isNoteTable) && table.length <= MAX_UPSTREAM_BYTES / 2) matches.push(table);
    if (matches.length >= 5) break;
  }
  return matches;
}

function findGradeTable(html) {
  const byId = html.match(/<table\b[^>]*id=["']dataList["'][^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (byId && /课程名称|课程名/.test(byId) && /成绩/.test(byId)) return byId;
  let best = '';
  for (const match of html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)) {
    const table = match[0];
    if ((/课程名称|课程名/.test(table)) && /成绩/.test(table) && table.length > best.length) best = table;
  }
  return best;
}

function isLoginPage(html) {
  return /id=["']loginForm["']|name=["']loginForm["']/.test(html);
}

function extractLoginMessage(html) {
  const raw = html.match(/<font\b[^>]*id=["']showMsg["'][^>]*>([\s\S]*?)<\/font>/i)?.[1] || '';
  return decodeHtml(raw.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value)
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function officialBase64(input) {
  const key = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const text = String(input);
  const output = [];
  let index = 0;
  do {
    const first = text.charCodeAt(index++);
    const second = text.charCodeAt(index++);
    const third = text.charCodeAt(index++);
    const enc1 = first >> 2;
    const enc2 = ((first & 3) << 4) | (second >> 4);
    let enc3 = ((second & 15) << 2) | (third >> 6);
    let enc4 = third & 63;
    if (Number.isNaN(second)) enc3 = enc4 = 64;
    else if (Number.isNaN(third)) enc4 = 64;
    output.push(key.charAt(enc1), key.charAt(enc2), key.charAt(enc3), key.charAt(enc4));
  } while (index < text.length);
  return output.join('');
}

async function requireSession(request, env) {
  const token = parseCookies(request.headers.get('cookie') || '')[SESSION_COOKIE];
  if (!token) throw httpError(401, '会话不存在，请刷新验证码后重新登录');
  try {
    const state = await decryptSession(token, env);
    if (!state?.exp || state.exp < Date.now() || !state.cookies) throw new Error('expired');
    return state;
  } catch {
    throw httpError(401, '会话已过期，请重新登录');
  }
}

async function encryptSession(value, env) {
  const key = await sessionKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: SESSION_AAD }, key, plaintext);
  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);
  return bytesToBase64Url(combined);
}

async function decryptSession(token, env) {
  const bytes = base64UrlToBytes(token);
  if (bytes.length < 29) throw new Error('invalid session');
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12);
  const key = await sessionKey(env);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: SESSION_AAD }, key, ciphertext);
  return JSON.parse(new TextDecoder().decode(decrypted));
}

async function sessionKey(env) {
  const hex = String(env.SESSION_SECRET || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw httpError(500, 'SESSION_SECRET 必须是 64 位十六进制密钥');
  const bytes = new Uint8Array(hex.match(/../g).map(value => parseInt(value, 16)));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : [];
}

function mergeResponseCookies(jar, headers) {
  for (const cookie of getSetCookieValues(headers)) {
    const pair = cookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(cookie)) delete jar[name];
    else jar[name] = value;
  }
}

function serializeCookieJar(jar) {
  return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; ');
}

function parseCookies(header) {
  const out = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator > 0) out[pair.slice(0, separator).trim()] = pair.slice(separator + 1).trim();
  }
  return out;
}

function sessionCookie(token, request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=${token}; Path=/api; HttpOnly${secure}; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`;
}

function clearSessionCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${SESSION_COOKIE}=; Path=/api; HttpOnly${secure}; SameSite=Strict; Max-Age=0`;
}

function upstreamOrigin(env) {
  const origin = String(env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM).replace(/\/$/, '');
  const parsed = new URL(origin);
  if (parsed.protocol !== 'https:') throw httpError(500, 'UPSTREAM_ORIGIN 必须使用 HTTPS');
  return parsed.origin;
}

function assertSameOrigin(request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw httpError(403, '请求来源无效');
}

async function readJson(request) {
  try {
    const length = Number(request.headers.get('content-length') || 0);
    if (length > 4096) throw httpError(413, '请求内容过大');
    return await request.json();
  } catch (error) {
    if (error?.status) throw error;
    throw httpError(400, '请求格式无效');
  }
}

function validateText(value, label, min, max) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) throw httpError(400, `${label}格式无效`);
  return text;
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  const headers = new Headers(extraHeaders);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store, max-age=0');
  headers.set('Pragma', 'no-cache');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  return new Response(JSON.stringify(data), { status, headers });
}

function httpError(status, message, expose = true) {
  const error = new Error(message);
  error.status = status;
  error.expose = expose;
  return error;
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
