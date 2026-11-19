const BATCH_SIZE = 50;
const RETRY_WINDOW_MS = 6 * 60 * 60 * 1000;

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(processDueReminders(env, controller.scheduledTime || Date.now()));
  }
};

async function processDueReminders(env, now) {
  if (!env.REMINDERS_DB || !env.RESEND_API_KEY || !env.REMINDER_FROM) {
    console.error(JSON.stringify({ event: 'reminder_configuration_missing' }));
    return;
  }
  await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='pending', updated_at=?
    WHERE status='sending' AND updated_at<? AND attempts<4`).bind(now, now - 15 * 60 * 1000).run();
  await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='failed', last_error='expired', updated_at=?
    WHERE status IN ('pending','sending') AND due_at<?`).bind(now, now - RETRY_WINDOW_MS).run();
  await env.REMINDERS_DB.prepare(`DELETE FROM reminder_subscriptions WHERE expires_at<?`).bind(now).run();

  const { results = [] } = await env.REMINDERS_DB.prepare(`SELECT
      j.id AS job_id, j.lead_minutes, j.attempts,
      s.email, e.name, e.start_at, e.end_at, e.room, e.campus, e.seat
    FROM reminder_jobs j
    JOIN reminder_subscriptions s ON s.id=j.subscription_id
    JOIN reminder_exams e ON e.id=j.exam_id
    WHERE j.status='pending' AND j.due_at<=? AND j.due_at>=?
      AND s.status='active' AND s.expires_at>?
    ORDER BY j.due_at ASC LIMIT ?`).bind(now, now - RETRY_WINDOW_MS, now, BATCH_SIZE).all();

  for (const job of results) {
    await deliverJob(env, job, now);
  }
  console.log(JSON.stringify({ event: 'reminder_run_complete', due: results.length }));
}

async function deliverJob(env, job, now) {
  const claimed = await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs
    SET status='sending', attempts=attempts+1, updated_at=? WHERE id=? AND status='pending'`)
    .bind(now, job.job_id).run();
  if (!Number(claimed?.meta?.changes || 0)) return;
  const start = new Date(Number(job.start_at));
  const dateTime = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(start);
  const leadLabel = Number(job.lead_minutes) === 4320 ? '3 天' : Number(job.lead_minutes) === 1440 ? '24 小时' : '2 小时';
  const location = [job.campus, job.room, job.seat ? `座位 ${job.seat}` : ''].filter(Boolean).join(' · ') || '地点待定';
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': `exam-reminder-${job.job_id}`
      },
      body: JSON.stringify({
        from: env.REMINDER_FROM,
        to: [job.email],
        subject: `考试提醒：${job.name} 将在${leadLabel}后开始`,
        html: `<div style="font-family:system-ui,sans-serif;line-height:1.7;color:#172033"><h2>${escapeHtml(job.name)}</h2><p>距离考试约 <strong>${leadLabel}</strong>。</p><p><strong>时间：</strong>${escapeHtml(dateTime)}<br><strong>地点：</strong>${escapeHtml(location)}</p><p style="color:#68738a">考试安排可能发生变化，请以学校教务系统和学院通知为准。</p></div>`
      })
    });
    if (!response.ok) throw new Error(`Resend ${response.status}`);
    const payload = await response.json();
    await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status='sent', provider_id=?, sent_at=?, updated_at=?, last_error=NULL WHERE id=?`)
      .bind(String(payload?.id || ''), now, now, job.job_id).run();
    console.log(JSON.stringify({ event: 'reminder_sent', jobId: job.job_id }));
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    await env.REMINDERS_DB.prepare(`UPDATE reminder_jobs SET status=?, last_error=?, updated_at=? WHERE id=?`)
      .bind(attempts >= 4 ? 'failed' : 'pending', String(error?.message || error).slice(0, 200), now, job.job_id).run();
    console.error(JSON.stringify({ event: 'reminder_send_failed', jobId: job.job_id, attempts }));
  }
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}
