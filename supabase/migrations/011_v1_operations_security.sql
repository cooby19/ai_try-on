-- 011：V1.0 正式營運基礎。
-- Email outbox、取消／退款、客服、風險、RBAC、稽核、資料保留與完整 RLS 防線。
-- 商業規則採保守預設：付款後 30 分鐘取消窗；完成後 7 天退款申請窗。

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to service_role;

alter table public.users
  add column if not exists closed_at timestamptz,
  add column if not exists anonymized_at timestamptz;

-- 照片刪除後以 NULL 明確表示已清除，避免用空字串假裝 Storage path。
alter table public.try_on_jobs alter column person_image_url drop not null;

-- Auth 帳戶刪除後仍需保留去識別化的訂單關聯；public.users 是營運用 pseudonymous subject。
alter table public.users drop constraint if exists users_id_auth_users_fkey;
alter table public.orders drop constraint if exists orders_user_id_fkey;
alter table public.orders
  add constraint orders_user_id_fkey foreign key (user_id) references public.users (id) on delete restrict;
alter table public.payments drop constraint if exists payments_user_id_fkey;
alter table public.payments
  add constraint payments_user_id_fkey foreign key (user_id) references public.users (id) on delete restrict;
alter table public.account_deletion_requests drop constraint if exists account_deletion_requests_user_id_fkey;
alter table public.account_deletion_requests
  add constraint account_deletion_requests_user_id_fkey foreign key (user_id) references public.users (id) on delete restrict;

alter table public.orders drop constraint if exists orders_status_check;
alter table public.orders
  add column if not exists shipped_at timestamptz,
  add column if not exists completed_at timestamptz,
  add constraint orders_status_check check (status in (
    'pending_payment', 'processing', 'payment_failed', 'cancellation_requested',
    'cancelled', 'shipped', 'completed', 'refund_pending',
    'partially_refunded', 'refunded', 'expired'
  ));

alter table public.payments drop constraint if exists payments_result_consistency_check;
alter table public.payments drop constraint if exists payments_status_check;
alter table public.payments
  add column if not exists refunded_amount numeric(12, 2) not null default 0 check (refunded_amount >= 0),
  add constraint payments_status_check check (status in (
    'pending', 'succeeded', 'failed', 'cancelled', 'expired',
    'refund_pending', 'partially_refunded', 'refunded'
  )),
  add constraint payments_result_consistency_check check (
    (status = 'pending' and paid_at is null and failure_reason is null)
    or (status in ('succeeded', 'refund_pending', 'partially_refunded', 'refunded') and paid_at is not null)
    or (status in ('failed', 'cancelled', 'expired') and paid_at is null)
  );

create table if not exists public.user_roles (
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('admin', 'operations', 'support', 'risk_analyst')),
  assigned_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id) on delete set null,
  recipient_email text not null check (recipient_email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'),
  template text not null check (template in (
    'order_created', 'order_status_changed', 'cancellation_requested',
    'refund_requested', 'refund_updated', 'support_ticket_created',
    'support_reply', 'security_alert'
  )),
  payload jsonb not null default '{}'::jsonb,
  dedupe_key text not null unique check (char_length(dedupe_key) between 1 and 300),
  status text not null default 'pending' check (status in ('pending', 'sending', 'sent', 'failed', 'dead')),
  attempt_count int not null default 0 check (attempt_count between 0 and 20),
  available_at timestamptz not null default now(),
  locked_at timestamptz,
  sent_at timestamptz,
  last_error text check (last_error is null or char_length(last_error) <= 1000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists notification_outbox_dispatch_idx
  on public.notification_outbox (status, available_at, created_at)
  where status in ('pending', 'failed');

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_number text not null unique default (
    'TKT-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10))
  ),
  user_id uuid not null references public.users (id) on delete restrict,
  order_id uuid references public.orders (id) on delete restrict,
  category text not null check (category in ('order', 'payment', 'refund', 'try_on', 'privacy', 'account', 'other')),
  subject text not null check (char_length(subject) between 3 and 120),
  status text not null default 'open' check (status in ('open', 'waiting_customer', 'in_progress', 'resolved', 'closed')),
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to uuid references auth.users (id) on delete set null,
  last_activity_at timestamptz not null default now(),
  resolved_at timestamptz,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists support_tickets_user_activity_idx on public.support_tickets (user_id, last_activity_at desc);
create index if not exists support_tickets_queue_idx on public.support_tickets (status, priority, last_activity_at desc);

create table if not exists public.support_messages (
  id uuid primary key default gen_random_uuid(),
  ticket_id uuid not null references public.support_tickets (id) on delete cascade,
  sender_user_id uuid references public.users (id) on delete set null,
  sender_role text not null check (sender_role in ('customer', 'staff', 'system')),
  body text not null check (char_length(body) between 1 and 5000),
  is_internal boolean not null default false,
  created_at timestamptz not null default now(),
  constraint support_messages_visibility_check check (
    not is_internal or sender_role in ('staff', 'system')
  )
);
create index if not exists support_messages_ticket_created_idx on public.support_messages (ticket_id, created_at);

create table if not exists public.refund_requests (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  payment_id uuid references public.payments (id) on delete restrict,
  user_id uuid not null references public.users (id) on delete restrict,
  request_type text not null check (request_type in ('cancellation', 'refund')),
  reason text not null check (char_length(reason) between 3 and 1000),
  requested_amount numeric(12, 2) not null check (requested_amount >= 0),
  approved_amount numeric(12, 2) check (approved_amount is null or approved_amount >= 0),
  status text not null default 'requested' check (status in (
    'requested', 'reviewing', 'approved', 'processing', 'succeeded',
    'rejected', 'failed', 'cancelled'
  )),
  reviewer_id uuid references auth.users (id) on delete set null,
  review_note text check (review_note is null or char_length(review_note) <= 2000),
  provider_refund_id text check (provider_refund_id is null or char_length(provider_refund_id) <= 200),
  reviewed_at timestamptz,
  completed_at timestamptz,
  inventory_restocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists refund_requests_one_active_per_order_idx
  on public.refund_requests (order_id)
  where status in ('requested', 'reviewing', 'approved', 'processing');
create index if not exists refund_requests_user_created_idx on public.refund_requests (user_id, created_at desc);
create index if not exists refund_requests_queue_idx on public.refund_requests (status, created_at);

create table if not exists public.order_status_events (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  from_status text,
  to_status text not null,
  actor_type text not null default 'system' check (actor_type in ('customer', 'staff', 'system', 'provider')),
  actor_user_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists order_status_events_order_created_idx on public.order_status_events (order_id, created_at);

create table if not exists public.risk_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users (id) on delete set null,
  order_id uuid references public.orders (id) on delete set null,
  event_type text not null check (char_length(event_type) between 3 and 80),
  severity text not null check (severity in ('low', 'medium', 'high', 'critical')),
  fingerprint text check (fingerprint is null or char_length(fingerprint) <= 200),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'false_positive')),
  assigned_to uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists risk_events_open_queue_idx on public.risk_events (severity, created_at desc) where status in ('open', 'investigating');
create index if not exists risk_events_user_created_idx on public.risk_events (user_id, created_at desc);

create table if not exists public.auth_attempt_events (
  id bigint generated always as identity primary key,
  user_id uuid references public.users (id) on delete set null,
  provider text not null check (provider in ('email_otp', 'google')),
  action text not null check (action in ('request', 'verify', 'callback')),
  outcome text not null check (outcome in ('requested', 'succeeded', 'failed', 'blocked')),
  email_hash text,
  ip_hash text,
  user_agent_hash text,
  created_at timestamptz not null default now(),
  constraint auth_attempt_events_fingerprint_check check (email_hash is not null or ip_hash is not null)
);
create index if not exists auth_attempt_events_email_created_idx on public.auth_attempt_events (email_hash, created_at desc) where email_hash is not null;
create index if not exists auth_attempt_events_ip_created_idx on public.auth_attempt_events (ip_hash, created_at desc) where ip_hash is not null;

create table if not exists public.admin_audit_logs (
  id bigint generated always as identity primary key,
  actor_user_id uuid references auth.users (id) on delete set null,
  action text not null check (char_length(action) between 3 and 120),
  target_type text not null check (char_length(target_type) between 2 and 80),
  target_id text,
  before_data jsonb,
  after_data jsonb,
  request_id text,
  ip_hash text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_logs_actor_created_idx on public.admin_audit_logs (actor_user_id, created_at desc);
create index if not exists admin_audit_logs_target_idx on public.admin_audit_logs (target_type, target_id, created_at desc);

create table if not exists public.data_retention_policies (
  data_class text primary key,
  retention_days int check (retention_days is null or retention_days > 0),
  disposition text not null check (disposition in ('delete', 'anonymize', 'retain_until_account_delete', 'legal_hold')),
  rationale text not null,
  requires_legal_review boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.data_retention_policies (data_class, retention_days, disposition, rationale, requires_legal_review)
values
  ('person_photos', 30, 'delete', '原始人物照只保留完成試穿與短期售後所需期間。', false),
  ('try_on_results', 90, 'delete', '結果圖提供短期回看，逾期自動移除檔案。', false),
  ('notification_logs', 180, 'delete', '保留寄送追蹤與退信排查紀錄。', false),
  ('auth_attempts', 90, 'delete', '只保留雜湊指紋，用於登入暴力嘗試與異常來源監控。', false),
  ('support_records', 1095, 'anonymize', '保留客服品質與爭議處理紀錄。', true),
  ('orders_payments', 2555, 'anonymize', '保留會計、稅務、退款與爭議證據；期限須由營運地法務確認。', true),
  ('risk_audit', 2555, 'anonymize', '保留安全事件與敏感操作稽核軌跡。', true),
  ('account_profile', null, 'retain_until_account_delete', '帳戶刪除完成時去識別化。', false)
on conflict (data_class) do update set
  retention_days = excluded.retention_days,
  disposition = excluded.disposition,
  rationale = excluded.rationale,
  requires_legal_review = excluded.requires_legal_review,
  updated_at = now();

-- 所有 public 表先開 RLS；敏感表不授權 anon/authenticated，僅後端 service_role 可達。
alter table public.user_roles enable row level security;
alter table public.notification_outbox enable row level security;
alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.refund_requests enable row level security;
alter table public.order_status_events enable row level security;
alter table public.risk_events enable row level security;
alter table public.auth_attempt_events enable row level security;
alter table public.admin_audit_logs enable row level security;
alter table public.data_retention_policies enable row level security;

revoke all privileges on table public.user_roles, public.notification_outbox,
  public.support_tickets, public.support_messages, public.refund_requests,
  public.order_status_events, public.risk_events, public.auth_attempt_events, public.admin_audit_logs,
  public.data_retention_policies from anon, authenticated;
grant all privileges on table public.user_roles, public.notification_outbox,
  public.support_tickets, public.support_messages, public.refund_requests,
  public.order_status_events, public.risk_events, public.auth_attempt_events, public.admin_audit_logs,
  public.data_retention_policies to service_role;
grant usage, select on sequence public.admin_audit_logs_id_seq to service_role;
grant usage, select on sequence public.auth_attempt_events_id_seq to service_role;

-- Defense in depth：即使未來誤加 table grant，RLS 仍只能看到本人資料。
drop policy if exists users_own_row on public.users;
create policy users_own_row on public.users for select to authenticated using ((select auth.uid()) = id);
drop policy if exists try_on_jobs_own_rows on public.try_on_jobs;
create policy try_on_jobs_own_rows on public.try_on_jobs for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists try_on_feedback_own_rows on public.try_on_feedback;
create policy try_on_feedback_own_rows on public.try_on_feedback for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists addresses_own_rows on public.addresses;
create policy addresses_own_rows on public.addresses for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists carts_own_rows on public.carts;
create policy carts_own_rows on public.carts for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists cart_items_own_rows on public.cart_items;
create policy cart_items_own_rows on public.cart_items for select to authenticated using (
  exists (select 1 from public.carts where carts.id = cart_items.cart_id and carts.user_id = (select auth.uid()))
);
drop policy if exists cart_merge_receipts_own_rows on public.cart_merge_receipts;
create policy cart_merge_receipts_own_rows on public.cart_merge_receipts for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists orders_own_rows on public.orders;
create policy orders_own_rows on public.orders for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists order_items_own_rows on public.order_items;
create policy order_items_own_rows on public.order_items for select to authenticated using (
  exists (select 1 from public.orders where orders.id = order_items.order_id and orders.user_id = (select auth.uid()))
);
drop policy if exists payments_own_rows on public.payments;
create policy payments_own_rows on public.payments for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists inventory_reservations_own_rows on public.inventory_reservations;
create policy inventory_reservations_own_rows on public.inventory_reservations for select to authenticated using (
  exists (select 1 from public.orders where orders.id = inventory_reservations.order_id and orders.user_id = (select auth.uid()))
);
drop policy if exists support_tickets_own_rows on public.support_tickets;
create policy support_tickets_own_rows on public.support_tickets for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists support_messages_own_rows on public.support_messages;
create policy support_messages_own_rows on public.support_messages for select to authenticated using (
  not is_internal and exists (
    select 1 from public.support_tickets
    where support_tickets.id = support_messages.ticket_id and support_tickets.user_id = (select auth.uid())
  )
);
drop policy if exists refund_requests_own_rows on public.refund_requests;
create policy refund_requests_own_rows on public.refund_requests for select to authenticated using ((select auth.uid()) = user_id);
drop policy if exists order_status_events_own_rows on public.order_status_events;
create policy order_status_events_own_rows on public.order_status_events for select to authenticated using (
  exists (select 1 from public.orders where orders.id = order_status_events.order_id and orders.user_id = (select auth.uid()))
);
drop policy if exists account_deletion_requests_own_rows on public.account_deletion_requests;
create policy account_deletion_requests_own_rows on public.account_deletion_requests for select to authenticated using ((select auth.uid()) = user_id);

-- Storage 保持 private，路徑第一段必須是 auth.uid；應用目前仍只由後端簽短效 URL。
update storage.buckets set public = false where id in ('person-uploads', 'try-on-results');
drop policy if exists v1_owner_read_private_images on storage.objects;
create policy v1_owner_read_private_images on storage.objects for select to authenticated using (
  bucket_id in ('person-uploads', 'try-on-results')
  and (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists v1_owner_insert_person_upload on storage.objects;
create policy v1_owner_insert_person_upload on storage.objects for insert to authenticated with check (
  bucket_id = 'person-uploads'
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
);
drop policy if exists v1_owner_delete_private_images on storage.objects;
create policy v1_owner_delete_private_images on storage.objects for delete to authenticated using (
  bucket_id in ('person-uploads', 'try-on-results')
  and (storage.foldername(name))[1] = (select auth.uid())::text
  and owner_id = (select auth.uid())::text
);

create or replace function private.touch_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

do $$
declare table_name text;
begin
  foreach table_name in array array[
    'notification_outbox', 'support_tickets', 'refund_requests', 'risk_events'
  ] loop
    execute format('drop trigger if exists touch_updated_at on public.%I', table_name);
    execute format('create trigger touch_updated_at before update on public.%I for each row execute function private.touch_updated_at()', table_name);
  end loop;
end;
$$;

create or replace function private.capture_order_status()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text; v_from_status text;
begin
  if tg_op = 'INSERT' then
    v_from_status := null;
  elsif old.status is distinct from new.status then
    v_from_status := old.status;
  else
    return new;
  end if;
    insert into public.order_status_events (order_id, from_status, to_status, metadata)
    values (new.id, v_from_status, new.status,
      jsonb_build_object('orderNumber', new.order_number));

    select email into v_email from public.users where id = new.user_id and closed_at is null;
    if v_email is not null then
      insert into public.notification_outbox (user_id, recipient_email, template, payload, dedupe_key)
      values (
        new.user_id, v_email,
        case when tg_op = 'INSERT' then 'order_created' else 'order_status_changed' end,
        jsonb_build_object('orderId', new.id, 'orderNumber', new.order_number, 'status', new.status, 'total', new.total),
        'order:' || new.id::text || ':' || new.status
      ) on conflict (dedupe_key) do nothing;
    end if;
  return new;
end;
$$;
drop trigger if exists capture_order_status on public.orders;
create trigger capture_order_status after insert or update of status on public.orders
  for each row execute function private.capture_order_status();

create or replace function private.capture_refund_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_email text; v_order_number text;
begin
  select users.email, orders.order_number into v_email, v_order_number
  from public.users join public.orders on orders.user_id = users.id
  where users.id = new.user_id and orders.id = new.order_id and users.closed_at is null;
  if v_email is not null then
    insert into public.notification_outbox (user_id, recipient_email, template, payload, dedupe_key)
    values (new.user_id, v_email,
      case when tg_op = 'INSERT' then
        case when new.request_type = 'cancellation' then 'cancellation_requested' else 'refund_requested' end
      else 'refund_updated' end,
      jsonb_build_object('requestId', new.id, 'orderId', new.order_id, 'orderNumber', v_order_number,
        'type', new.request_type, 'status', new.status, 'requestedAmount', new.requested_amount,
        'approvedAmount', new.approved_amount),
      'refund:' || new.id::text || ':' || new.status
    ) on conflict (dedupe_key) do nothing;
  end if;
  return new;
end;
$$;
drop trigger if exists capture_refund_notification on public.refund_requests;
create trigger capture_refund_notification after insert or update of status on public.refund_requests
  for each row execute function private.capture_refund_notification();

create or replace function private.capture_support_notification()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_ticket public.support_tickets%rowtype; v_email text;
begin
  select * into v_ticket from public.support_tickets where id = new.ticket_id;
  update public.support_tickets set last_activity_at = new.created_at where id = new.ticket_id;
  if new.sender_role in ('staff', 'system') and not new.is_internal then
    select email into v_email from public.users where id = v_ticket.user_id and closed_at is null;
    if v_email is not null then
      insert into public.notification_outbox (user_id, recipient_email, template, payload, dedupe_key)
      values (v_ticket.user_id, v_email, 'support_reply',
        jsonb_build_object('ticketId', v_ticket.id, 'ticketNumber', v_ticket.ticket_number, 'subject', v_ticket.subject),
        'support-message:' || new.id::text
      ) on conflict (dedupe_key) do nothing;
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists capture_support_notification on public.support_messages;
create trigger capture_support_notification after insert on public.support_messages
  for each row execute function private.capture_support_notification();

create or replace function public.request_order_cancellation(p_user_id uuid, p_order_id uuid, p_reason text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.orders%rowtype; v_payment public.payments%rowtype; v_request public.refund_requests%rowtype;
begin
  if p_user_id is null or p_order_id is null or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if exists (select 1 from public.refund_requests where order_id = p_order_id and status in ('requested','reviewing','approved','processing')) then
    return jsonb_build_object('status', 'already_requested');
  end if;
  select * into v_payment from public.payments where order_id = p_order_id for update;

  if v_order.status in ('pending_payment', 'payment_failed') then
    update public.inventory_reservations set status = 'released', released_at = now(), updated_at = now()
      where order_id = p_order_id and status = 'active';
    if v_payment.id is not null and v_payment.status = 'pending' then
      update public.payments set status = 'cancelled', failure_reason = '使用者取消訂單', updated_at = now() where id = v_payment.id;
    end if;
    update public.orders set status = 'cancelled', updated_at = now() where id = p_order_id;
    insert into public.refund_requests (order_id, payment_id, user_id, request_type, reason, requested_amount, approved_amount, status, completed_at)
    values (p_order_id, v_payment.id, p_user_id, 'cancellation', btrim(p_reason), 0, 0, 'succeeded', now()) returning * into v_request;
    return jsonb_build_object('status', 'cancelled', 'requestId', v_request.id, 'refundRequired', false);
  end if;

  if v_order.status = 'processing' and v_payment.status = 'succeeded'
     and v_payment.paid_at >= now() - interval '30 minutes' then
    insert into public.refund_requests (order_id, payment_id, user_id, request_type, reason, requested_amount)
    values (p_order_id, v_payment.id, p_user_id, 'cancellation', btrim(p_reason), v_order.total)
    returning * into v_request;
    update public.orders set status = 'cancellation_requested', updated_at = now() where id = p_order_id;
    return jsonb_build_object('status', 'requested', 'requestId', v_request.id, 'refundRequired', true);
  end if;
  return jsonb_build_object('status', 'not_eligible', 'reason', 'cancellation_window_closed');
end;
$$;

create or replace function public.request_order_refund(p_user_id uuid, p_order_id uuid, p_reason text)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_order public.orders%rowtype; v_payment public.payments%rowtype; v_request public.refund_requests%rowtype;
begin
  if p_user_id is null or p_order_id is null or char_length(btrim(coalesce(p_reason, ''))) not between 3 and 1000 then
    return jsonb_build_object('status', 'invalid_input');
  end if;
  select * into v_order from public.orders where id = p_order_id and user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if exists (select 1 from public.refund_requests where order_id = p_order_id and status in ('requested','reviewing','approved','processing')) then
    return jsonb_build_object('status', 'already_requested');
  end if;
  select * into v_payment from public.payments where order_id = p_order_id for update;
  if v_order.status = 'completed' and v_order.completed_at >= now() - interval '7 days'
     and v_payment.status in ('succeeded', 'partially_refunded') then
    insert into public.refund_requests (order_id, payment_id, user_id, request_type, reason, requested_amount)
    values (p_order_id, v_payment.id, p_user_id, 'refund', btrim(p_reason), greatest(v_order.total - v_payment.refunded_amount, 0))
    returning * into v_request;
    update public.orders set status = 'refund_pending', updated_at = now() where id = p_order_id;
    return jsonb_build_object('status', 'requested', 'requestId', v_request.id);
  end if;
  return jsonb_build_object('status', 'not_eligible', 'reason', 'refund_window_closed');
end;
$$;

create or replace function public.review_refund_request(
  p_actor_user_id uuid, p_request_id uuid, p_action text,
  p_approved_amount numeric default null, p_note text default null,
  p_provider_refund_id text default null
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare v_request public.refund_requests%rowtype; v_order public.orders%rowtype; v_payment public.payments%rowtype; v_amount numeric(12,2);
begin
  if not exists (select 1 from public.user_roles where user_id = p_actor_user_id and role in ('admin','operations')) then
    return jsonb_build_object('status', 'forbidden');
  end if;
  select * into v_request from public.refund_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('status', 'not_found'); end if;
  select * into v_order from public.orders where id = v_request.order_id for update;
  select * into v_payment from public.payments where id = v_request.payment_id for update;

  if p_action = 'approve' and v_request.status in ('requested','reviewing') then
    v_amount := coalesce(p_approved_amount, v_request.requested_amount);
    if v_amount < 0 or v_amount > v_request.requested_amount then return jsonb_build_object('status', 'invalid_amount'); end if;
    update public.refund_requests set status = 'approved', approved_amount = v_amount, reviewer_id = p_actor_user_id,
      review_note = nullif(btrim(coalesce(p_note,'')),''), reviewed_at = now() where id = p_request_id;
    update public.orders set status = 'refund_pending', updated_at = now() where id = v_order.id;
    update public.payments set status = 'refund_pending', updated_at = now() where id = v_payment.id;
  elsif p_action = 'reject' and v_request.status in ('requested','reviewing') then
    update public.refund_requests set status = 'rejected', reviewer_id = p_actor_user_id,
      review_note = nullif(btrim(coalesce(p_note,'')),''), reviewed_at = now(), completed_at = now() where id = p_request_id;
    update public.orders set status = case when v_request.request_type = 'refund' then 'completed' else 'processing' end, updated_at = now() where id = v_order.id;
  elsif p_action = 'mark_processing' and v_request.status = 'approved' then
    update public.refund_requests set status = 'processing', provider_refund_id = nullif(btrim(coalesce(p_provider_refund_id,'')),''), updated_at = now() where id = p_request_id;
  elsif p_action = 'mark_succeeded' and v_request.status in ('approved','processing') then
    v_amount := coalesce(v_request.approved_amount, v_request.requested_amount);
    update public.refund_requests set status = 'succeeded', provider_refund_id = coalesce(nullif(btrim(coalesce(p_provider_refund_id,'')),''), provider_refund_id), completed_at = now() where id = p_request_id;
    update public.payments set refunded_amount = least(refunded_amount + v_amount, v_order.total),
      status = case when refunded_amount + v_amount >= v_order.total then 'refunded' else 'partially_refunded' end, updated_at = now() where id = v_payment.id;
    update public.orders set status = case when v_payment.refunded_amount + v_amount >= v_order.total then 'refunded' else 'partially_refunded' end, updated_at = now() where id = v_order.id;
    if v_request.request_type = 'cancellation' and v_amount >= v_order.total and v_request.inventory_restocked_at is null then
      update public.product_variants as variant set stock_quantity = variant.stock_quantity + item.quantity, updated_at = now()
      from public.order_items as item where item.order_id = v_order.id and item.variant_id = variant.id;
      update public.refund_requests set inventory_restocked_at = now() where id = p_request_id;
    end if;
  elsif p_action = 'mark_failed' and v_request.status in ('approved','processing') then
    update public.refund_requests set status = 'failed', review_note = coalesce(nullif(btrim(coalesce(p_note,'')),''), review_note), completed_at = now() where id = p_request_id;
    update public.payments set status = 'succeeded', updated_at = now() where id = v_payment.id;
    update public.orders set status = case when v_request.request_type = 'refund' then 'completed' else 'processing' end, updated_at = now() where id = v_order.id;
  else
    return jsonb_build_object('status', 'invalid_transition');
  end if;
  insert into public.admin_audit_logs (actor_user_id, action, target_type, target_id, before_data, after_data)
  select p_actor_user_id, 'refund.' || p_action, 'refund_request', p_request_id::text, to_jsonb(v_request), to_jsonb(updated)
  from public.refund_requests as updated where updated.id = p_request_id;
  return jsonb_build_object('status', 'success');
end;
$$;

create or replace function public.claim_notification_batch(p_limit int default 20)
returns setof public.notification_outbox language plpgsql security invoker set search_path = '' as $$
begin
  return query
  with claimed as (
    select id from public.notification_outbox
    where (status in ('pending','failed') and available_at <= now())
       or (status = 'sending' and locked_at < now() - interval '10 minutes')
    order by available_at, created_at
    for update skip locked limit greatest(1, least(coalesce(p_limit,20),100))
  )
  update public.notification_outbox as outbox
  set status = 'sending', locked_at = now(), attempt_count = attempt_count + 1, updated_at = now()
  from claimed where outbox.id = claimed.id returning outbox.*;
end;
$$;

revoke execute on function public.request_order_cancellation(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.request_order_refund(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function public.review_refund_request(uuid, uuid, text, numeric, text, text) from public, anon, authenticated;
revoke execute on function public.claim_notification_batch(int) from public, anon, authenticated;
grant execute on function public.request_order_cancellation(uuid, uuid, text) to service_role;
grant execute on function public.request_order_refund(uuid, uuid, text) to service_role;
grant execute on function public.review_refund_request(uuid, uuid, text, numeric, text, text) to service_role;
grant execute on function public.claim_notification_batch(int) to service_role;

-- 付款事件重送／晚到、以及退款高頻都保留風險紀錄供後台處理。
create or replace function private.capture_payment_risk()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_user_id uuid; v_count int;
begin
  select user_id into v_user_id from public.orders where id = new.order_id;
  if new.ignored then
    insert into public.risk_events (user_id, order_id, event_type, severity, fingerprint, details)
    values (v_user_id, new.order_id, 'ignored_payment_webhook', 'medium', new.event_id::text,
      jsonb_build_object('eventId', new.event_id, 'result', new.result))
    on conflict do nothing;
  end if;
  select count(*) into v_count from public.payment_webhook_events
    where order_id = new.order_id and processed_at >= now() - interval '10 minutes';
  if v_count >= 4 then
    insert into public.risk_events (user_id, order_id, event_type, severity, fingerprint, details)
    values (v_user_id, new.order_id, 'payment_webhook_velocity', 'high', 'payment-velocity:' || new.order_id::text,
      jsonb_build_object('eventsIn10Minutes', v_count));
  end if;
  return new;
end;
$$;
drop trigger if exists capture_payment_risk on public.payment_webhook_events;
create trigger capture_payment_risk after insert on public.payment_webhook_events
  for each row execute function private.capture_payment_risk();

create or replace function private.capture_refund_risk()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  select count(*) into v_count from public.refund_requests
    where user_id = new.user_id and created_at >= now() - interval '30 days';
  if v_count >= 3 then
    insert into public.risk_events (user_id, order_id, event_type, severity, fingerprint, details)
    values (new.user_id, new.order_id, 'refund_request_velocity', 'high', 'refund-velocity:' || new.user_id::text,
      jsonb_build_object('requestsIn30Days', v_count));
  end if;
  return new;
end;
$$;
drop trigger if exists capture_refund_risk on public.refund_requests;
create trigger capture_refund_risk after insert on public.refund_requests
  for each row execute function private.capture_refund_risk();

create or replace function private.capture_order_risk()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  select count(*) into v_count from public.orders
    where user_id = new.user_id and created_at >= now() - interval '10 minutes';
  if v_count >= 5 then
    if not exists (
      select 1 from public.risk_events
      where fingerprint = 'order-velocity:' || new.user_id::text
        and event_type = 'order_creation_velocity' and status in ('open','investigating')
    ) then
      insert into public.risk_events (user_id, order_id, event_type, severity, fingerprint, details)
      values (new.user_id, new.id, 'order_creation_velocity', 'high', 'order-velocity:' || new.user_id::text,
        jsonb_build_object('ordersIn10Minutes', v_count));
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists capture_order_risk on public.orders;
create trigger capture_order_risk after insert on public.orders
  for each row execute function private.capture_order_risk();

create or replace function private.enqueue_risk_alert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_recipient record;
begin
  if new.severity in ('high', 'critical') then
    for v_recipient in
      select distinct users.id, users.email
      from public.user_roles join public.users on users.id = user_roles.user_id
      where user_roles.role in ('admin','operations','risk_analyst')
        and users.email is not null and users.closed_at is null
    loop
      insert into public.notification_outbox (user_id, recipient_email, template, payload, dedupe_key)
      values (v_recipient.id, v_recipient.email, 'security_alert',
        jsonb_build_object('riskEventId', new.id, 'eventType', new.event_type, 'severity', new.severity),
        'risk-alert:' || new.id::text || ':' || v_recipient.id::text)
      on conflict (dedupe_key) do nothing;
    end loop;
  end if;
  return new;
end;
$$;
drop trigger if exists enqueue_risk_alert on public.risk_events;
create trigger enqueue_risk_alert after insert on public.risk_events
  for each row execute function private.enqueue_risk_alert();

revoke execute on all functions in schema private from public, anon, authenticated;
grant execute on all functions in schema private to service_role;
