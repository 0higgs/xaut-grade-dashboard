ALTER TABLE reminder_subscriptions ADD COLUMN encrypted_session TEXT;
ALTER TABLE reminder_subscriptions ADD COLUMN session_expires_at INTEGER;
ALTER TABLE reminder_subscriptions ADD COLUMN sync_status TEXT NOT NULL DEFAULT 'disabled';
ALTER TABLE reminder_subscriptions ADD COLUMN next_sync_at INTEGER;
ALTER TABLE reminder_subscriptions ADD COLUMN last_sync_at INTEGER;
ALTER TABLE reminder_subscriptions ADD COLUMN last_sync_error TEXT;
ALTER TABLE reminder_subscriptions ADD COLUMN session_notice_sent_at INTEGER;
ALTER TABLE reminder_subscriptions ADD COLUMN lead_minutes TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reminder_subscriptions ADD COLUMN pending_notice TEXT;

ALTER TABLE reminder_exams ADD COLUMN source_key TEXT NOT NULL DEFAULT '';
ALTER TABLE reminder_exams ADD COLUMN updated_at INTEGER;

CREATE INDEX IF NOT EXISTS idx_reminder_subscriptions_sync
  ON reminder_subscriptions(status, sync_status, next_sync_at);

CREATE INDEX IF NOT EXISTS idx_reminder_exams_source
  ON reminder_exams(subscription_id, source_key);
