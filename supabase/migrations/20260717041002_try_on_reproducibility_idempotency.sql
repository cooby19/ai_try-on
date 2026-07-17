-- Try-On 可重現性、生命週期欄位、結構化錯誤與 DB 保證的 idempotency。
-- 舊資料無法回填真實 seed／設定／執行時間，因此相關欄位保留 nullable；
-- config_snapshot 用空物件明確表示 legacy，而不是捏造歷史設定。
alter table public.try_on_jobs
  add column if not exists config_snapshot jsonb not null default '{}'::jsonb,
  add column if not exists seed bigint,
  add column if not exists started_at timestamptz,
  add column if not exists provider_submitted_at timestamptz,
  add column if not exists completed_at timestamptz,
  add column if not exists last_polled_at timestamptz,
  add column if not exists error_type text,
  add column if not exists error_code text,
  add column if not exists provider_http_status integer,
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text;

alter table public.try_on_jobs
  add constraint try_on_jobs_seed_range_check
    check (seed is null or seed between 0 and 4294967295),
  add constraint try_on_jobs_snapshot_seed_check
    check (seed is null or config_snapshot #>> '{generation,seed}' = seed::text),
  add constraint try_on_jobs_error_type_check
    check (error_type is null or error_type in (
      'input_validation', 'authorization', 'product_lookup', 'quota',
      'person_image_read', 'garment_image_read', 'provider_submit',
      'provider_poll', 'provider_rejected', 'provider_output_download',
      'enhancement', 'result_storage', 'database', 'timeout', 'internal'
    )),
  add constraint try_on_jobs_provider_http_status_check
    check (provider_http_status is null or provider_http_status between 100 and 599),
  add constraint try_on_jobs_idempotency_pair_check
    check ((idempotency_key is null) = (request_fingerprint is null)),
  add constraint try_on_jobs_idempotency_key_check
    check (idempotency_key is null or idempotency_key ~ '^[A-Za-z0-9._:-]{1,128}$'),
  add constraint try_on_jobs_request_fingerprint_check
    check (request_fingerprint is null or request_fingerprint ~ '^[0-9a-f]{64}$'),
  add constraint try_on_jobs_lifecycle_order_check
    check (
      (provider_submitted_at is null or started_at is null or provider_submitted_at >= started_at)
      and (completed_at is null or started_at is null or completed_at >= started_at)
      and (completed_at is null or provider_submitted_at is null or completed_at >= provider_submitted_at)
    ),
  add constraint try_on_jobs_completed_terminal_check
    check (completed_at is null or status in ('success', 'failed'));

create unique index try_on_jobs_user_idempotency_key_uidx
  on public.try_on_jobs (user_id, idempotency_key)
  where idempotency_key is not null;

comment on column public.try_on_jobs.config_snapshot is
  '後端解析後的生成設定快照；{} 表示 migration 前 legacy 資料。';
comment on column public.try_on_jobs.seed is
  '後端產生或可信內部呼叫指定的 unsigned 32-bit generation seed。';
comment on column public.try_on_jobs.started_at is
  'Workflow 開始並建立 job 的應用程式時鐘時間。';
comment on column public.try_on_jobs.provider_submitted_at is
  'Provider 已回傳 job id、確認接受任務的應用程式時鐘時間。';
comment on column public.try_on_jobs.completed_at is
  '首次進入 success/failed 終態的應用程式時鐘時間；後續讀取不得覆寫。';
comment on column public.try_on_jobs.last_polled_at is
  '最近一次實際呼叫 Provider status API 的應用程式時鐘時間。';

create or replace function private.preserve_try_on_job_creation_snapshot()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- 生成設定與冪等身分在建立後不可被 poll／清圖流程覆寫。
  new.seed := old.seed;
  new.config_snapshot := old.config_snapshot;
  new.started_at := old.started_at;
  new.idempotency_key := old.idempotency_key;
  new.request_fingerprint := old.request_fingerprint;
  if old.completed_at is not null then
    new.completed_at := old.completed_at;
  end if;
  return new;
end;
$$;

revoke execute on function private.preserve_try_on_job_creation_snapshot()
  from public, anon, authenticated, service_role;

drop trigger if exists preserve_try_on_job_creation_snapshot on public.try_on_jobs;
create trigger preserve_try_on_job_creation_snapshot
before update on public.try_on_jobs
for each row execute function private.preserve_try_on_job_creation_snapshot();

-- 移除所有歷史 overload，避免舊入口繞過新的 idempotency／snapshot 欄位。
drop function if exists public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, timestamptz, int, int
);
drop function if exists public.insert_try_on_job_within_quota(
  uuid, text, uuid, text, text, text, numeric, numeric, timestamptz, int, int, int, numeric
);
drop function if exists public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, numeric, timestamptz, int, int, numeric
);

create function public.insert_try_on_job_within_quota(
  p_user_id uuid,
  p_product_id uuid,
  p_person_image_url text,
  p_garment_image_url text,
  p_provider text,
  p_cost_estimate numeric,
  p_budget_reservation numeric,
  p_since timestamptz,
  p_daily_limit integer,
  p_product_attempt_limit integer,
  p_platform_daily_budget numeric,
  p_seed bigint,
  p_config_snapshot jsonb,
  p_started_at timestamptz,
  p_idempotency_key text default null,
  p_request_fingerprint text default null
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_used_today integer;
  v_product_attempts integer;
  v_platform_reserved numeric;
  v_job public.try_on_jobs%rowtype;
begin
  if not exists (select 1 from auth.users where id = p_user_id)
     or p_product_id is null
     or p_person_image_url is null
     or p_garment_image_url is null
     or p_provider is null
     or p_cost_estimate is null
     or p_cost_estimate < 0
     or p_budget_reservation is null
     or p_budget_reservation < p_cost_estimate
     or p_since is null
     or p_daily_limit is null or p_daily_limit <= 0
     or p_product_attempt_limit is null or p_product_attempt_limit <= 0
     or p_platform_daily_budget is null or p_platform_daily_budget <= 0
     or p_seed is null
     or p_seed not between 0 and 4294967295
     or p_started_at is null
     or p_config_snapshot is null
     or pg_catalog.jsonb_typeof(p_config_snapshot) <> 'object'
     or (p_config_snapshot ->> 'schemaVersion') is distinct from '1'
     or (p_config_snapshot #>> '{generation,seed}') is distinct from p_seed::text
     or ((p_idempotency_key is null) <> (p_request_fingerprint is null))
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[A-Za-z0-9._:-]{1,128}$')
     or (p_request_fingerprint is not null and p_request_fingerprint !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid authenticated user or try-on creation input';
  end if;

  -- 已完成的 replay 不需占用平台鎖；這只是快速路徑，鎖內仍會再次檢查。
  if p_idempotency_key is not null then
    select * into v_job
    from public.try_on_jobs
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      select pg_catalog.count(*) into v_used_today
      from public.try_on_jobs
      where user_id = p_user_id and created_at >= p_since;
      if v_job.request_fingerprint = p_request_fingerprint then
        return pg_catalog.jsonb_build_object(
          'outcome', 'replayed', 'used_today', v_used_today,
          'product_attempts_today', v_job.retry_count, 'job', to_jsonb(v_job)
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'used_today', v_used_today,
        'product_attempts_today', v_job.retry_count, 'job', to_jsonb(v_job)
      );
    end if;
  end if;

  -- 固定鎖順序不可改：平台 → Auth 使用者。
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform:' || p_since::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user:' || p_user_id::text || ':' || p_since::text, 0)
  );

  -- 等鎖期間可能已有同 key transaction commit，必須在額度檢查前重查。
  if p_idempotency_key is not null then
    select * into v_job
    from public.try_on_jobs
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if found then
      select pg_catalog.count(*) into v_used_today
      from public.try_on_jobs
      where user_id = p_user_id and created_at >= p_since;
      if v_job.request_fingerprint = p_request_fingerprint then
        return pg_catalog.jsonb_build_object(
          'outcome', 'replayed', 'used_today', v_used_today,
          'product_attempts_today', v_job.retry_count, 'job', to_jsonb(v_job)
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'outcome', 'conflict', 'used_today', v_used_today,
        'product_attempts_today', v_job.retry_count, 'job', to_jsonb(v_job)
      );
    end if;
  end if;

  select coalesce(pg_catalog.sum(budget_reservation), 0)
    into v_platform_reserved
  from public.try_on_jobs
  where created_at >= p_since;

  select pg_catalog.count(*) into v_used_today
  from public.try_on_jobs
  where user_id = p_user_id and created_at >= p_since;

  select pg_catalog.count(*) into v_product_attempts
  from public.try_on_jobs
  where user_id = p_user_id and product_id = p_product_id and created_at >= p_since;

  if v_platform_reserved + p_budget_reservation > p_platform_daily_budget then
    return pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'reject_reason', 'platform',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;
  if v_used_today >= p_daily_limit then
    return pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'reject_reason', 'daily',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;
  if v_product_attempts >= p_product_attempt_limit then
    return pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'reject_reason', 'product',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;

  begin
    insert into public.try_on_jobs (
      user_id, product_id, person_image_url, garment_image_url,
      provider, status, cost_estimate, budget_reservation, retry_count,
      seed, config_snapshot, started_at, idempotency_key, request_fingerprint
    ) values (
      p_user_id, p_product_id, p_person_image_url, p_garment_image_url,
      p_provider, 'pending', p_cost_estimate, p_budget_reservation, v_product_attempts,
      p_seed, p_config_snapshot, p_started_at, p_idempotency_key, p_request_fingerprint
    ) returning * into v_job;
  exception when unique_violation then
    -- Partial unique index 是 advisory lock 之外的最後防線；任何旁路競態都收斂成明確結果。
    select * into v_job
    from public.try_on_jobs
    where user_id = p_user_id and idempotency_key = p_idempotency_key;
    if not found then
      raise;
    end if;
    select pg_catalog.count(*) into v_used_today
    from public.try_on_jobs
    where user_id = p_user_id and created_at >= p_since;
    if v_job.request_fingerprint = p_request_fingerprint then
      return pg_catalog.jsonb_build_object(
        'outcome', 'replayed', 'used_today', v_used_today,
        'product_attempts_today', v_job.retry_count, 'job', to_jsonb(v_job)
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'outcome', 'conflict', 'used_today', v_used_today,
      'product_attempts_today', v_job.retry_count, 'job', to_jsonb(v_job)
    );
  end;

  return pg_catalog.jsonb_build_object(
    'outcome', 'created', 'used_today', v_used_today + 1,
    'product_attempts_today', v_product_attempts, 'job', to_jsonb(v_job)
  );
end;
$$;

revoke execute on function public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, numeric, timestamptz, integer, integer,
  numeric, bigint, jsonb, timestamptz, text, text
) from public, anon, authenticated;
grant execute on function public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, numeric, timestamptz, integer, integer,
  numeric, bigint, jsonb, timestamptz, text, text
) to service_role;
