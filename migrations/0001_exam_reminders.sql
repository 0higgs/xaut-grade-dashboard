PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS reminder_subscriptions (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'disabled')),
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reminder_subscriptions_status
  ON reminder_subscriptions(status, expires_at);

CREATE TABLE IF NOT EXISTS reminder_exams (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  term TEXT NOT NULL DEFAULT '',
  code TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER,
  room TEXT NOT NULL DEFAULT '',
  campus TEXT NOT NULL DEFAULT '',
  seat TEXT NOT NULL DEFAULT '',
  UNIQUE(subscription_id, fingerprint),
  FOREIGN KEY(subscription_id) REFERENCES reminder_subscriptions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminder_exams_subscription
  ON reminder_exams(subscription_id, start_at);

CREATE TABLE IF NOT EXISTS reminder_jobs (
  id TEXT PRIMARY KEY,
  subscription_id TEXT NOT NULL,
  exam_id TEXT NOT NULL,
  lead_minutes INTEGER NOT NULL CHECK (lead_minutes IN (120, 1440, 4320)),
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  sent_at INTEGER,
  UNIQUE(subscription_id, exam_id, lead_minutes),
  FOREIGN KEY(subscription_id) REFERENCES reminder_subscriptions(id) ON DELETE CASCADE,
  FOREIGN KEY(exam_id) REFERENCES reminder_exams(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_reminder_jobs_due
  ON reminder_jobs(status, due_at);
