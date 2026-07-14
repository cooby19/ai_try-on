-- 006：V0.4 帳戶刪除申請。
-- 本 migration 只建立申請佇列；不會刪除 auth.users、照片或任何既有資料列。

create table if not exists public.account_deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id),
  requested_at timestamptz not null default now(),
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'rejected', 'cancelled')),
  reason text check (reason is null or char_length(reason) <= 1000),
  updated_at timestamptz not null default now(),
  processed_at timestamptz
);

-- 歷史上可以有多筆已完成／拒絕／取消申請，但同一使用者同時只能有一筆待處理申請。
create unique index if not exists account_deletion_requests_one_pending_per_user_idx
  on public.account_deletion_requests (user_id)
  where status = 'pending';

create index if not exists account_deletion_requests_status_requested_idx
  on public.account_deletion_requests (status, requested_at);

-- 跟既有資料表相同：前端 anon/authenticated key 沒有 policy，所有操作只經過
-- 已驗證 Auth session 的後端 API，再由 service_role 存取。
alter table public.account_deletion_requests enable row level security;
grant all privileges on table public.account_deletion_requests to service_role;
