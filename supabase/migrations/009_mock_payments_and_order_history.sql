-- 009：V0.7 模擬金流、付款 Webhook 冪等處理與訂單歷史。
-- 本 migration 不包含任何真實金流 provider、憑證或扣款邏輯。

alter table public.orders
  drop constraint if exists orders_status_check;

-- V0.6 雖沒有付款流程，但保留了 paid 狀態；若測試資料曾手動標記，升級時轉成新版處理中。
update public.orders set status = 'processing' where status = 'paid';

alter table public.orders
  add constraint orders_status_check
  check (status in ('pending_payment', 'processing', 'payment_failed', 'cancelled', 'expired'));

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null unique references public.orders (id) on delete restrict,
  user_id uuid not null references auth.users (id) on delete restrict,
  provider text not null default 'mock' check (provider = 'mock'),
  transaction_id text not null unique
    check (transaction_id ~ '^MOCK-[0-9]{13}-[0-9A-F]{12}$'),
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'cancelled', 'expired')),
  failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 300),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payments_result_consistency_check check (
    (status = 'pending' and paid_at is null and failure_reason is null)
    or (status = 'succeeded' and paid_at is not null and failure_reason is null)
    or (status in ('failed', 'cancelled', 'expired') and paid_at is null)
  )
);

create index if not exists payments_user_created_idx
  on public.payments (user_id, created_at desc);

create table if not exists public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  payment_id uuid not null references public.payments (id) on delete restrict,
  order_id uuid not null references public.orders (id) on delete restrict,
  result text not null check (result in ('succeeded', 'failed', 'cancelled', 'expired')),
  failure_reason text check (failure_reason is null or char_length(failure_reason) between 1 and 300),
  payload jsonb not null,
  ignored boolean not null default false,
  processed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists payment_webhook_events_payment_processed_idx
  on public.payment_webhook_events (payment_id, processed_at desc);
create index if not exists payment_webhook_events_order_processed_idx
  on public.payment_webhook_events (order_id, processed_at desc);

alter table public.payments enable row level security;
alter table public.payment_webhook_events enable row level security;

revoke all privileges on table public.payments from anon, authenticated;
revoke all privileges on table public.payment_webhook_events from anon, authenticated;
grant all privileges on table public.payments to service_role;
grant all privileges on table public.payment_webhook_events to service_role;

create or replace function public.process_mock_payment_webhook(
  p_event_id uuid,
  p_order_id uuid,
  p_transaction_id text,
  p_result text,
  p_failure_reason text,
  p_payload jsonb
) returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_order public.orders%rowtype;
  v_payment public.payments%rowtype;
  v_existing_event public.payment_webhook_events%rowtype;
  v_failure_reason text := nullif(btrim(coalesce(p_failure_reason, '')), '');
  v_next_order_status text;
  v_ignored boolean := false;
begin
  if p_event_id is null or p_order_id is null
     or coalesce(p_transaction_id, '') !~ '^MOCK-[0-9]{13}-[0-9A-F]{12}$'
     or coalesce(p_result, '') not in ('succeeded', 'failed', 'cancelled', 'expired')
     or p_payload is null
     or (v_failure_reason is not null and char_length(v_failure_reason) > 300) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  select * into v_order
  from public.orders
  where id = p_order_id
  for update;
  if not found then
    return jsonb_build_object('status', 'missing_order');
  end if;

  -- event_id 是 provider webhook 的冪等鍵。重送相同事件只讀取既有結果；
  -- 若同一 event_id 被挪作不同 payload，則明確拒絕而不是悄悄採用。
  select * into v_existing_event
  from public.payment_webhook_events
  where event_id = p_event_id;
  if found then
    select * into v_payment from public.payments where id = v_existing_event.payment_id;
    if v_existing_event.order_id <> p_order_id
       or v_existing_event.result <> p_result
       or v_payment.transaction_id <> p_transaction_id then
      return jsonb_build_object('status', 'event_conflict');
    end if;
    return jsonb_build_object(
      'status', 'success',
      'reused', true,
      'ignored', v_existing_event.ignored,
      'orderStatus', v_order.status,
      'paymentStatus', v_payment.status
    );
  end if;

  select * into v_payment
  from public.payments
  where order_id = p_order_id
  for update;

  if not found then
    insert into public.payments (order_id, user_id, transaction_id)
    values (v_order.id, v_order.user_id, p_transaction_id)
    returning * into v_payment;
  elsif v_payment.transaction_id <> p_transaction_id then
    return jsonb_build_object('status', 'transaction_conflict');
  end if;

  -- 訂單與付款結果一旦進入終態就不接受另一個事件覆寫，但仍保留被忽略的事件供稽核。
  v_ignored := v_order.status <> 'pending_payment' or v_payment.status <> 'pending';

  insert into public.payment_webhook_events (
    event_id, payment_id, order_id, result, failure_reason, payload, ignored
  ) values (
    p_event_id, v_payment.id, v_order.id, p_result, v_failure_reason, p_payload, v_ignored
  );

  if v_ignored then
    return jsonb_build_object(
      'status', 'success',
      'reused', false,
      'ignored', true,
      'orderStatus', v_order.status,
      'paymentStatus', v_payment.status
    );
  end if;

  if p_result = 'succeeded' then
    v_next_order_status := 'processing';
    v_failure_reason := null;
  elsif p_result = 'failed' then
    v_next_order_status := 'payment_failed';
    v_failure_reason := coalesce(v_failure_reason, '模擬付款失敗');
  elsif p_result = 'cancelled' then
    v_next_order_status := 'cancelled';
    v_failure_reason := coalesce(v_failure_reason, '使用者取消模擬付款');
  else
    v_next_order_status := 'expired';
    v_failure_reason := coalesce(v_failure_reason, '模擬付款逾期');
  end if;

  update public.payments
  set
    status = p_result,
    failure_reason = v_failure_reason,
    paid_at = case when p_result = 'succeeded' then now() else null end,
    updated_at = now()
  where id = v_payment.id
  returning * into v_payment;

  update public.orders
  set status = v_next_order_status, updated_at = now()
  where id = v_order.id
  returning * into v_order;

  return jsonb_build_object(
    'status', 'success',
    'reused', false,
    'ignored', false,
    'orderStatus', v_order.status,
    'paymentStatus', v_payment.status
  );
end;
$$;

revoke execute on function public.process_mock_payment_webhook(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.process_mock_payment_webhook(uuid, uuid, text, text, text, jsonb)
  to service_role;
