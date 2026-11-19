import {
  SessionExpiredError, decryptSyncSession, encryptSyncSession, examSourceKey, examTimestamp, fetchCurrentExams
} from './exam-sync.js';

const REMINDER_BATCH_SIZE = 50;
const SYNC_BATCH_SIZE = 8;
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export default {
  async scheduled(controller, env) {
    const now = controller.scheduledTime || Date.now();
    await processExamSyncs(env, now);
    await processDueReminders(env, now);
  }
};

export async function processExamSyncs(env, now = Date.now()) {
  if (!env.REMINDERS_DB || !env.RESEND_API_KEY || !env.REMINDER_FROM || !env.SYNC_SESSION_SECRET) {
    console.error(JSON.stringify({ event: 'exam_sync_configuration_missing' }));
    return;
  }
  const { results = [] } = await env.REMINDERS_DB.prepare(`SELECT id,email,encrypted_session,lead_minutes,session_expires_at,pending_notice
    FROM reminder_subscriptions
    WHERE status='active' AND sync_status='ready' AND encrypted_session IS NOT NULL
      AND next_sync_at<=? AND expires_at>?
    ORDER BY next_sync_at ASC LIMIT ?`).bind(now, now, SYNC_BATCH_SIZE).all();
  for (const subscription of results) await syncSubscription(env, subscription, now);
  if (results.length) console.log(JSON.stringify({ event: 'exam_sync_run_complete', checked: results.length }));
}

async function syncSubscription(env, subscription, now) {
  const claimed = await env.REMINDERS_DB.prepare(`UPDATE reminder_subscriptions
    SET next_sync_at=?,updated_at=? WHERE id=? AND status='active' AND sync_status='ready' AND next_sync_at<=?`)
    .bind(now + RETRY_WINDOW_MS, now, subscription.id, now).run();
  if (!Number(claimed?.meta?.changes || 0)) return;
  try {
    if (subscription.pending_notice) await flushPendingNotice(env, subscription);
    if (Number(subscription.session_expires_at || 0) <= now) throw new SessionExpiredError();
    const session = await decryptSyncSession(subscription.encrypted_session, env);
    const fetched = await fetchCurrentExams(session, env);
    const encryptedSession = await encryptSyncSession(fetched.session, env);
    const summary = await reconcileExams(env, subscription, fetched.items, now);
    const nextSyncAt = now + DAY_MS + syncJitter(subscription.id, now);
    await env.REMINDERS_DB.prepare(`UPDATE reminder_subscriptions SET encrypted_session=?,sync_status='ready',
      next_sync_at=?,last_sync_at=?,last_sync_error=NULL,updated_at=? WHERE id=?`)
      .bind(encryptedSession, nextSyncAt, now, now, subscription.id).run();
    if (summary.newItems.length || summary.changedItems.length) {
      const notice = JSON.stringify({ ...summary, createdAt: now });
      await env.REMINDERS_DB.prepare('UPDATE reminder_subscriptions SET pending_notice=? WHERE id=?').bind(notice, subscription.id).run();
      await sendExamChangeEmail(env, subscription, summary, now);
      await env.REMINDERS_DB.prepare('UPDATE reminder_subscriptions SET pending_notice=NULL WHERE id=?').bind(subscription.id).run();
    }
    console.log(JSON.stringify({ event: 'exam_sync_succeeded', subscriptionId: subscription.id,
      newCount: summary.newItems.length, changedCount: summary.changedItems.length }));
  } catch (error) {
    if (error instanceof SessionExpiredError) return handleExpiredSession(env, subscription, now);
    await env.REMINDERS_DB.prepare(`UPDATE reminder_subscriptions SET next_sync_at=?,last_sync_error=?,updated_at=? WHERE id=?`)
      .bind(now + RETRY_WINDOW_MS, String(error?.message || error).slice(0, 300), now, subscription.id).run();
    console.error(JSON.stringify({ event: 'exam_sync_failed', subscriptionId: subscription.id, message: String(error?.message || error).slice(0, 160) }));
  }
}

async function flushPendingNotice(env, subscription) {
  let notice;
  try { notice = JSON.parse(subscription.pending_notice); } catch {
    await env.REMINDERS_DB.prepare('UPDATE reminder_subscriptions SET pending_notice=NULL WHERE id=?').bind(subscription.id).run();
    return;
  }
  if (!Array.isArray(notice.newItems) || !Array.isArray(notice.changedItems)) return;
  await sendExamChangeEmail(env, subscription, notice, Number(notice.createdAt) || Date.now());
  await env.REMINDERS_DB.prepare('UPDATE reminder_subscriptions SET pending_notice=NULL WHERE id=?').bind(subscription.id).run();
  subscription.pending_notice = null;
}

async function reconcileExams(env, subscription, fetchedItems, now) {
  const { results: existing = [] } = await env.REMINDERS_DB.prepare(`SELECT id,source_key,fingerprint,term,code,name,start_at,end_at,room,campus,seat
    FROM reminder_exams WHERE subscription_id=?`).bind(subscription.id).all();
  const bySource = new Map(existing.map(item => [item.source_key || examSourceKey(item), item]));
  const leads = parseLeads(subscription.lead_minutes);
  const newItems = [], changedItems = [];
  for (const item of fetchedItems) {
    const startAt = examTimestamp(item), endAt = examTimestamp(item, true);
    if (!Number.isFinite(startAt) || startAt <= now) continue;
    const sourceKey = examSourceKey(item);
    if (!sourceKey) continue;
    const fingerprint = `${sourceKey}|${startAt}`.slice(0, 300);
    const normalized = {
      term: safeText(item.term, 32), code: safeText(item.code, 64), name: safeText(item.name, 160), startAt,
      endAt: Number.isFinite(endAt) ? endAt : null, room: safeText(item.room, 160), campus: safeText(item.campus, 160),
      seat: safeText(item.seat, 64), sourceKey, fingerprint
    };
    const current = bySource.get(sourceKey);
    if (!current) {
      const examId = crypto.randomUUID();
      const statements = [env.REMINDERS_DB.prepare(`INSERT INTO reminder_exams
        (id,subscription_id,fingerprint,term,code,name,start_at,end_at,room,campus,seat,source_key,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(examId, subscription.id, fingerprint, normalized.term, normalized.code,
          normalized.name, startAt, normalized.endAt, normalized.room, normalized.campus, normalized.seat, sourceKey, now)];
      addJobs(statements, env, subscription.id, examId, startAt, leads, now);
      await env.REMINDERS_DB.batch(statements);
      newItems.push(normalized);
      bySource.set(sourceKey, { id: examId, ...normalized, start_at: startAt, end_at: normalized.endAt });
      continue;
    }
    if (!current.source_key) {
      await env.REMINDERS_DB.prepare('UPDATE reminder_exams SET source_key=?,updated_at=? WHERE id=?').bind(sourceKey, now, current.id).run();
      current.source_key = sourceKey;
    }
    const changed = Number(current.start_at) !== startAt || Number(current.end_at || 0) !== Number(normalized.endAt || 0)
      || String(current.room || '') !== normalized.room || String(current.campus || '') !== normalized.campus || String(current.seat || '') !== normalized.seat;
    if (!changed) continue;
    const statements = [
      env.REMINDERS_DB.prepare(`UPDATE reminder_exams SET fingerprint=?,term=?,code=?,name=?,start_at=?,end_at=?,room=?,campus=?,seat=?,updated_at=? WHERE id=?`)
        .bind(fingerprint, normalized.term, normalized.code, normalized.name, startAt, normalized.endAt, normalized.room, normalized.campus, normalized.seat, now, current.id),
      env.REMINDERS_DB.prepare(`DELETE FROM reminder_jobs WHERE exam_id=? AND status IN ('pending','failed')`).bind(current.id)
    ];
    addJobs(statements, env, subscription.id, current.id, startAt, leads, now);
    await env.REMINDERS_DB.batch(statements);
    changedItems.push(normalized);
  }
  if (newItems.length || changedItems.length) {
    const latest = [...newItems, ...changedItems].reduce((max, item) => Math.max(max, item.endAt || item.startAt), now);
    await env.REMINDERS_DB.prepare('UPDATE reminder_subscriptions SET expires_at=MAX(expires_at,?),updated_at=? WHERE id=?')
      .bind(latest + 30 * DAY_MS, now, subscription.id).run();
  }
  return { newItems, changedItems };
}

function addJobs(statements, env, subscriptionId, examId, startAt, leads, now) {
  for (const lead of leads) {
    const dueAt = startAt - lead * 60000;
    if (dueAt < now - RETRY_WINDOW_MS) continue;
    statements.push(env.REMINDERS_DB.prepare(`INSERT OR IGNORE INTO reminder_jobs
      (id,subscription_id,exam_id,lead_minutes,due_at,status,attempts,created_at,updated_at)
      VALUES (?,?,?,?,?,'pending',0,?,?)`).bind(crypto.randomUUID(), subscriptionId, examId, lead, dueAt, now, now));
  }
}

async function handleExpiredSession(env, subscription, now) {
  const row = await env.REMINDERS_DB.prepare('SELECT session_notice_sent_at FROM reminder_subscriptions WHERE id=?').bind(subscription.id).first();
  await env.REMINDERS_DB.prepare(`UPDATE reminder_subscriptions SET sync_status='session_expired',encrypted_session=NULL,
    next_sync_at=NULL,last_sync_at=?,last_sync_error='session expired',updated_at=? WHERE id=?`)
    .bind(now, now, subscription.id).run();
  if (Number(row?.session_notice_sent_at || 0)) return;
  try {
    await sendEmail(env, {
      to: subscription.email, subject: '考试安排自动检查需要重新登录',
      html: `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#172033"><h2>自动检查已暂停</h2><p>教务系统登录会话已经失效。请重新打开成绩速查工具并登录，然后再次提交邮件提醒，即可恢复每天自动检查。</p><p style="color:#68738a">已创建的考试提醒仍会按原计划发送。</p></div>`,
      text: '考试安排自动检查已暂停\n\n教务系统登录会话已经失效。请重新打开成绩速查工具并登录，然后再次提交邮件提醒，即可恢复每天自动检查。已创建的考试提醒仍会按原计划发送。'
    }, `exam-session-expired-${subscription.id}`);
    await env.REMINDERS_DB.prepare('UPDATE reminder_subscriptions SET session_notice_sent_at=? WHERE id=?').bind(now, subscription.id).run();
  } catch {
    console.error(JSON.stringify({ event: 'session_expired_notice_failed', subscriptionId: subscription.id }));
  }
}

async function sendExamChangeEmail(env, subscription, summary, now) {
  const rows = [...summary.newItems.map(item => ({ ...item, label: '新增' })), ...summary.changedItems.map(item => ({ ...item, label: '变更' }))];
  const htmlRows = rows.map(item => `<li><strong>[${item.label}] ${escapeHtml(item.name)}</strong><br>${escapeHtml(formatExam(item))}</li>`).join('');
  const textRows = rows.map(item => `[${item.label}] ${item.name}\n${formatExam(item)}`).join('\n\n');
  const subject = summary.newItems.length && summary.changedItems.length ? '发现新增和变更的考试安排'
    : summary.newItems.length ? `发现 ${summary.newItems.length} 门新考试安排` : `发现 ${summary.changedItems.length} 门考试安排变更`;
  await sendEmail(env, {
    to: subscription.email, subject,
    html: `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#172033"><h2>${escapeHtml(subject)}</h2><ul style="padding-left:22px">${htmlRows}</ul><p style="color:#68738a">请以教务系统和学院最新通知为准。</p></div>`,
    text: `${subject}\n\n${textRows}\n\n请以教务系统和学院最新通知为准。`
  }, `exam-change-${subscription.id}-${now}`);
}

async function processDueReminders(env, now) {
  if (!env.REMINDERS_DB || !env.RESEND_API_KEY || !env.REMINDER_FROM) {
    console.error(JSON.stringify({ event: 'reminder_configuration_missing' }));
    return;
  }
  await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='pending',updated_at=?
    WHERE status='sending' AND updated_at<? AND attempts<4`).bind(now, now - 15 * 60 * 1000).run();
  await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='failed',last_error='expired',updated_at=?
    WHERE status IN ('pending','sending') AND due_at<?`).bind(now, now - RETRY_WINDOW_MS).run();
  await env.REMINDERS_DB.prepare(`DELETE FROM reminder_subscriptions WHERE expires_at<?`).bind(now).run();
  const { results = [] } = await env.REMINDERS_DB.prepare(`SELECT
      j.id AS job_id,j.lead_minutes,j.attempts,s.email,e.name,e.start_at,e.end_at,e.room,e.campus,e.seat
    FROM reminder_jobs j JOIN reminder_subscriptions s ON s.id=j.subscription_id JOIN reminder_exams e ON e.id=j.exam_id
    WHERE j.status='pending' AND j.due_at<=? AND j.due_at>=? AND s.status='active' AND s.expires_at>?
    ORDER BY j.due_at ASC LIMIT ?`).bind(now, now - RETRY_WINDOW_MS, now, REMINDER_BATCH_SIZE).all();
  for (const job of results) await deliverJob(env, job, now);
  console.log(JSON.stringify({ event: 'reminder_run_complete', due: results.length }));
}

async function deliverJob(env, job, now) {
  const claimed = await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='pending'`)
    .bind(now, job.job_id).run();
  if (!Number(claimed?.meta?.changes || 0)) return;
  const dateTime = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Number(job.start_at)));
  const leadLabel = Number(job.lead_minutes) === 4320 ? '3 天' : Number(job.lead_minutes) === 1440 ? '24 小时' : '2 小时';
  const location = [job.campus, job.room, job.seat ? `座位 ${job.seat}` : ''].filter(Boolean).join(' · ') || '地点待定';
  try {
    const payload = await sendEmail(env, {
      to: job.email, subject: `考试提醒：${job.name} 将在${leadLabel}后开始`,
      html: `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#172033"><h2>${escapeHtml(job.name)}</h2><p>距离考试约 <strong>${leadLabel}</strong>。</p><p><strong>时间：</strong>${escapeHtml(dateTime)}<br><strong>地点：</strong>${escapeHtml(location)}</p><p style="color:#68738a">考试安排可能发生变化，请以学校教务系统和学院通知为准。</p></div>`,
      text: `${job.name}\n\n距离考试约 ${leadLabel}。\n时间：${dateTime}\n地点：${location}\n\n考试安排可能发生变化，请以学校教务系统和学院通知为准。`
    }, `exam-reminder-${job.job_id}`);
    await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='sent',provider_id=?,sent_at=?,updated_at=?,last_error=NULL WHERE id=?`)
      .bind(String(payload?.id || ''), now, now, job.job_id).run();
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status=?,last_error=?,updated_at=? WHERE id=?`)
      .bind(attempts >= 4 ? 'failed' : 'pending', String(error?.message || error).slice(0, 200), now, job.job_id).run();
  }
}

async function sendEmail(env, message, idempotencyKey) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST', headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
    body: JSON.stringify({ from: env.REMINDER_FROM, to: [message.to], subject: message.subject, html: message.html, text: message.text })
  });
  if (!response.ok) throw new Error(`Resend ${response.status}`);
  return response.json();
}

function parseLeads(value) {
  try { return [...new Set(JSON.parse(value))].map(Number).filter(item => [120, 1440, 4320].includes(item)); } catch { return [1440, 120]; }
}

function syncJitter(id, now) {
  const text = `${id}|${Math.floor(now / DAY_MS)}`;
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return Math.abs(hash) % (3 * 60 * 60 * 1000);
}

function formatExam(item) {
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(item.startAt));
  const location = [item.campus, item.room, item.seat ? `座位 ${item.seat}` : ''].filter(Boolean).join(' · ') || '地点待定';
  return `${time} · ${location}`;
}

function safeText(value, max) { return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max); }
function escapeHtml(value) { return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
