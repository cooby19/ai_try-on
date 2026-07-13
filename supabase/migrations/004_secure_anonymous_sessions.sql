-- 004：以可撤銷匿名 session 取代可偽造的 vto_uid，並加入來源額度與平台預算熔斷。
-- 必須在部署本版程式前執行。舊 vto_uid 不遷移，也不再具有任何授權能力。

create table if not exists public.anonymous_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  token_hash text not null unique,
  source_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists anonymous_sessions_source_created_idx
  on public.anonymous_sessions (source_hash, created_at);
create index if not exists anonymous_sessions_user_idx
  on public.anonymous_sessions (user_id);

alter table public.anonymous_sessions enable row level security;
grant all privileges on table public.anonymous_sessions to service_role;

-- 原始 IP 不落庫；應用層只傳入使用專用 secret 做過 HMAC 的來源值。
alter table public.try_on_jobs add column if not exists source_hash text;
alter table public.try_on_jobs add column if not exists budget_reservation numeric(10, 4);
update public.try_on_jobs
set budget_reservation = cost_estimate
where budget_reservation is null;
alter table public.try_on_jobs alter column budget_reservation set default 0;
alter table public.try_on_jobs alter column budget_reservation set not null;
create index if not exists try_on_jobs_source_created_idx
  on public.try_on_jobs (source_hash, created_at);

-- 原子建立 user + session，並限制同一來源每日可建立的匿名身分數。
create or replace function public.create_anonymous_session(
  p_token_hash text,
  p_source_hash text,
  p_expires_at timestamptz,
  p_since timestamptz,
  p_creation_limit int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_created_today int;
  v_user_id uuid := gen_random_uuid();
begin
  if length(p_token_hash) <> 64 or length(p_source_hash) <> 64 then
    raise exception 'invalid session hash';
  end if;
  if p_creation_limit <= 0 or p_expires_at <= now() then
    raise exception 'invalid anonymous session policy';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('anonymous-session:' || p_source_hash || ':' || p_since::text, 0)
  );
  select count(*) into v_created_today
  from public.anonymous_sessions
  where source_hash = p_source_hash and created_at >= p_since;

  if v_created_today >= p_creation_limit then
    return jsonb_build_object('allowed', false);
  end if;

  insert into public.users (id) values (v_user_id);
  insert into public.anonymous_sessions (user_id, token_hash, source_hash, expires_at)
  values (v_user_id, p_token_hash, p_source_hash, p_expires_at);

  return jsonb_build_object('allowed', true, 'user_id', v_user_id);
end;
$$;

revoke execute on function public.create_anonymous_session(
  text, text, timestamptz, timestamptz, int
) from public, anon, authenticated;
grant execute on function public.create_anonymous_session(
  text, text, timestamptz, timestamptz, int
) to service_role;

-- 002 的函式簽章沒有來源與平台預算參數，必須移除，避免任何後端程式誤走舊入口。
drop function if exists public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, timestamptz, int, int
);
drop function if exists public.insert_try_on_job_within_quota(
  uuid, text, uuid, text, text, text, numeric, timestamptz, int, int, int, numeric
);

create or replace function public.insert_try_on_job_within_quota(
  p_user_id uuid,
  p_source_hash text,
  p_product_id uuid,
  p_person_image_url text,
  p_garment_image_url text,
  p_provider text,
  p_cost_estimate numeric,
  p_budget_reservation numeric,
  p_since timestamptz,
  p_daily_limit int,
  p_product_attempt_limit int,
  p_source_daily_limit int,
  p_platform_daily_budget numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used_today int;
  v_source_used_today int;
  v_product_attempts int;
  v_platform_reserved numeric;
  v_job public.try_on_jobs;
begin
  if length(p_source_hash) <> 64
     or p_cost_estimate < 0
     or p_budget_reservation < p_cost_estimate then
    raise exception 'invalid cost-control input';
  end if;

  -- 固定鎖順序：平台 → 來源 → 使用者，避免不同請求以不同順序取鎖造成 deadlock。
  -- 這三個判定與 insert 在同一交易內，因此清 cookie 與併發請求都不能越界。
  perform pg_advisory_xact_lock(hashtextextended('platform:' || p_since::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('source:' || p_source_hash || ':' || p_since::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('user:' || p_user_id::text || ':' || p_since::text, 0));

  select coalesce(sum(budget_reservation), 0) into v_platform_reserved
  from public.try_on_jobs
  where created_at >= p_since;

  select count(*) into v_source_used_today
  from public.try_on_jobs
  where source_hash = p_source_hash and created_at >= p_since;

  select count(*) into v_used_today
  from public.try_on_jobs
  where user_id = p_user_id and created_at >= p_since;

  select count(*) into v_product_attempts
  from public.try_on_jobs
  where user_id = p_user_id and product_id = p_product_id and created_at >= p_since;

  if v_platform_reserved + p_budget_reservation > p_platform_daily_budget then
    return jsonb_build_object(
      'allowed', false, 'reject_reason', 'platform',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;
  if v_source_used_today >= p_source_daily_limit then
    return jsonb_build_object(
      'allowed', false, 'reject_reason', 'source',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;
  if v_used_today >= p_daily_limit then
    return jsonb_build_object(
      'allowed', false, 'reject_reason', 'daily',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;
  if v_product_attempts >= p_product_attempt_limit then
    return jsonb_build_object(
      'allowed', false, 'reject_reason', 'product',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;

  insert into public.try_on_jobs
    (user_id, source_hash, product_id, person_image_url, garment_image_url,
     provider, status, cost_estimate, budget_reservation, retry_count)
  values
    (p_user_id, p_source_hash, p_product_id, p_person_image_url, p_garment_image_url,
     p_provider, 'pending', p_cost_estimate, p_budget_reservation, v_product_attempts)
  returning * into v_job;

  return jsonb_build_object(
    'allowed', true,
    'used_today', v_used_today + 1,
    'product_attempts_today', v_product_attempts,
    'job', to_jsonb(v_job)
  );
end;
$$;

revoke execute on function public.insert_try_on_job_within_quota(
  uuid, text, uuid, text, text, text, numeric, numeric, timestamptz, int, int, int, numeric
) from public, anon, authenticated;
grant execute on function public.insert_try_on_job_within_quota(
  uuid, text, uuid, text, text, text, numeric, numeric, timestamptz, int, int, int, numeric
) to service_role;
