-- 未設定 Email provider 的測試環境：保留通知軌跡，但不得把未寄送通知誤標示為 sent。
alter table public.notification_outbox
  add column if not exists skipped_at timestamptz;

alter table public.notification_outbox
  drop constraint if exists notification_outbox_status_check;

alter table public.notification_outbox
  add constraint notification_outbox_status_check
  check (status in ('pending', 'sending', 'sent', 'skipped', 'failed', 'dead'));

comment on column public.notification_outbox.skipped_at is
  '未設定 Email provider 的測試模式略過派送時間；並非 Email 實際送達時間。';
