const DEFAULT_UPSTREAM = 'https://jwgl.xaut.edu.cn';
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024;
const SYNC_AAD = new TextEncoder().encode('xaut-exam-reminder-session-v1');

export class SessionExpiredError extends Error {
  constructor(message = '教务系统登录会话已失效') {
    super(message);
    this.name = 'SessionExpiredError';
  }
}

export async function fetchCurrentExams(session, env) {
  const jar = { ...(session?.cookies || {}) };
  if (!Object.keys(jar).length) throw new SessionExpiredError();
  const pagePath = '/jsxsd/xsks/xsksap_query';
  const page = await upstreamRequest(pagePath, { headers: { Accept: 'text/html,application/xhtml+xml' } }, jar, env);
  if (isLoginPage(page)) throw new SessionExpiredError();
  const terms = parseExamTerms(page).slice(0, 30);
  const selectedTerm = parseSelectedExamTerm(page) || terms[0] || '';
  if (!selectedTerm) throw new Error('教务系统未返回可用学期');

  const items = [];
  let total = 0;
  const pageSize = 200;
  for (let pageNum = 1; pageNum <= 3; pageNum++) {
    const query = new URLSearchParams({ xnxqid: selectedTerm, xqlb: '', pageNum: String(pageNum), pageSize: String(pageSize) });
    const text = await upstreamRequest(`/jsxsd/xsks/xsksap_list?${query}`, {
      headers: { Accept: 'application/json,text/plain,*/*', Referer: `${upstreamOrigin(env)}${pagePath}` }
    }, jar, env);
    if (isLoginPage(text)) throw new SessionExpiredError();
    const payload = parseExamPayload(text, selectedTerm);
    total = Math.max(total, payload.count);
    items.push(...payload.items);
    if (items.length >= total || payload.items.length < pageSize) break;
  }
  return { session: { cookies: jar, capturedAt: Date.now() }, terms, selectedTerm, items: items.slice(0, 600) };
}

export async function encryptSyncSession(value, env) {
  const key = await syncKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: SYNC_AAD }, key, plaintext);
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);
  return bytesToBase64Url(combined);
}

export async function decryptSyncSession(token, env) {
  const bytes = base64UrlToBytes(token);
  if (bytes.length < 29) throw new Error('invalid encrypted session');
  const key = await syncKey(env);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: SYNC_AAD }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function examSourceKey(item) {
  return [item.term, item.code, item.name].map(value => String(value || '').trim().toLowerCase()).join('|').slice(0, 300);
}

export function examTimestamp(item, end = false) {
  const date = String(item?.date || '');
  const time = String((end ? item?.endTime : item?.startTime) || item?.startTime || '');
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return NaN;
  return Date.parse(`${date}T${time}:00+08:00`);
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
      method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(20000)
    });
    mergeResponseCookies(jar, response.headers);
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) throw new Error(`教务系统返回 HTTP ${response.status}`);
      return new TextDecoder().decode(await readResponseBody(response));
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('教务系统返回了无效跳转');
    const next = new URL(location, url);
    if (next.origin !== upstreamOrigin(env)) throw new Error('教务系统跳转到了非预期域名');
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET'; body = undefined; headers = new Headers({ Accept: headers.get('Accept') || 'text/html' });
    }
    url = next;
  }
  throw new Error('教务系统跳转次数过多');
}

async function readResponseBody(response) {
  const length = Number(response.headers.get('content-length') || 0);
  if (length > MAX_UPSTREAM_BYTES) throw new Error('教务系统响应过大');
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_UPSTREAM_BYTES) throw new Error('教务系统响应过大');
  return bytes;
}

function parseExamTerms(html) {
  const select = html.match(/<select\b[^>]*(?:name|id)=["']xnxqid["'][^>]*>[\s\S]*?<\/select>/i)?.[0] || '';
  const terms = [];
  for (const match of select.matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>/gi)) {
    const value = decodeHtml(match[1]).trim();
    if (/^20\d{2}-20\d{2}-[123]$/.test(value) && !terms.includes(value)) terms.push(value);
  }
  return terms;
}

function parseSelectedExamTerm(html) {
  const select = html.match(/<select\b[^>]*(?:name|id)=["']xnxqid["'][^>]*>[\s\S]*?<\/select>/i)?.[0] || '';
  const selected = select.match(/<option\b[^>]*value=["']([^"']+)["'][^>]*\bselected(?:=["'][^"']*["'])?[^>]*>/i)?.[1]
    || select.match(/<option\b[^>]*\bselected(?:=["'][^"']*["'])?[^>]*value=["']([^"']+)["'][^>]*>/i)?.[1] || '';
  return decodeHtml(selected).trim();
}

function parseExamPayload(text, selectedTerm) {
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (payload !== null) {
    if (payload?.code !== undefined && String(payload.code) !== '0') throw new Error('教务系统考试安排接口返回异常');
    const data = Array.isArray(payload?.data) ? payload.data : [];
    return { count: Math.max(0, Number(payload?.count) || data.length), items: data.map((row, index) => normalizeExamItem(row, selectedTerm, index)).filter(item => item.name) };
  }
  const table = parseExamTable(text, selectedTerm);
  if (table) return table;
  if (/暂无(?:数据|记录|考试)|没有(?:数据|记录)|未查询到/.test(stripHtml(text))) return { count: 0, items: [] };
  throw new Error('教务系统没有返回可识别的考试安排');
}

function normalizeExamItem(row, selectedTerm, index) {
  const value = (...keys) => {
    for (const key of keys) {
      const candidate = row?.[key];
      if (candidate !== undefined && candidate !== null && String(candidate).trim()) return stripHtml(candidate);
    }
    return '';
  };
  const timeText = value('kssj', 'kssjmc', 'examTime');
  return {
    index: index + 1, term: value('xnxqid', 'xnxq01id') || selectedTerm,
    code: value('kch', 'kcdm', 'courseCode'), name: value('kskcmc', 'kcmc', 'kc_mc', 'courseName'), timeText,
    ...parseExamTime(timeText), room: value('js_mc', 'ksdd', 'ksjc', 'jsmc', 'room'),
    campus: value('ksxq', 'xqmc', 'campus'), teacher: value('jsxm', 'xm', 'teacher'),
    seat: value('zwh', 'seat'), admissionNo: value('zkzh', 'admissionNo'), session: value('ksccmc', 'kscc', 'session'),
    type: value('kslbmc', 'kslb', 'kslx', 'ksxz', 'type'), note: value('bz', 'bzxx', 'remark')
  };
}

function parseExamTable(html, selectedTerm) {
  const table = Array.from(String(html).matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi), match => match[0])
    .find(candidate => /\bid=["']dataList["']/i.test(candidate) && /课程名称/.test(candidate) && /考试时间/.test(candidate));
  if (!table) return null;
  const rows = Array.from(table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi), match => match[1]);
  const headers = Array.from((rows.find(row => /<th\b/i.test(row)) || '').matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi), match => stripHtml(match[1]));
  if (!headers.includes('课程名称') || !headers.includes('考试时间')) return null;
  const items = [];
  for (const row of rows) {
    const cells = Array.from(row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi), match => stripHtml(match[1]));
    const get = label => cells[headers.indexOf(label)] || '';
    const name = get('课程名称');
    if (!cells.length || !name) continue;
    const timeText = get('考试时间');
    items.push({ index: Number(get('序号')) || items.length + 1, term: selectedTerm, code: get('课程编号'), name, timeText,
      ...parseExamTime(timeText), room: get('考场'), campus: get('考试校区') || get('校区'), teacher: get('授课教师'),
      seat: get('座位号'), admissionNo: get('准考证号'), session: get('考试场次'), type: '', note: get('备注') });
    if (items.length >= 600) break;
  }
  return { count: items.length, items };
}

function parseExamTime(value) {
  const match = String(value || '').match(/(20\d{2}-\d{2}-\d{2})\s+(\d{1,2}:\d{2})\s*[~～—–-]\s*(\d{1,2}:\d{2})/);
  return { date: match?.[1] || '', startTime: match?.[2]?.padStart(5, '0') || '', endTime: match?.[3]?.padStart(5, '0') || '' };
}

function isLoginPage(text) {
  const body = String(text || '');
  return /id=["']loginForm["']|name=["']USERNAME["']|LoginToXk|验证码/.test(body) && /密码|登录|USERNAME|PASSWORD/.test(body);
}

function stripHtml(value) {
  return decodeHtml(String(value || '').replace(/<br\s*\/?\s*>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function decodeHtml(value) {
  return String(value || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function upstreamOrigin(env) {
  const parsed = new URL(String(env.UPSTREAM_ORIGIN || DEFAULT_UPSTREAM).replace(/\/$/, ''));
  if (parsed.protocol !== 'https:') throw new Error('UPSTREAM_ORIGIN 必须使用 HTTPS');
  return parsed.origin;
}

function getSetCookieValues(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw ? raw.split(/,(?=\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+=)/) : [];
}

function mergeResponseCookies(jar, headers) {
  for (const cookie of getSetCookieValues(headers)) {
    const pair = cookie.split(';', 1)[0], separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim(), value = pair.slice(separator + 1).trim();
    if (/max-age=0|expires=Thu, 01 Jan 1970/i.test(cookie)) delete jar[name]; else jar[name] = value;
  }
}

function serializeCookieJar(jar) { return Object.entries(jar).map(([name, value]) => `${name}=${value}`).join('; '); }

async function syncKey(env) {
  const hex = String(env.SYNC_SESSION_SECRET || '').trim();
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error('SYNC_SESSION_SECRET 配置无效');
  return crypto.subtle.importKey('raw', new Uint8Array(hex.match(/../g).map(value => parseInt(value, 16))), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function base64UrlToBytes(value) {
  const binary = atob(String(value).replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(String(value).length / 4) * 4, '='));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}
