-- 測試期間暫時停用使用者每日與同商品生成次數限制。
-- 維持既有 RPC signature：null 代表未啟用該限制，平台每日預算、鎖順序、
-- idempotency、RLS 與 service_role 授權皆維持不變。重新啟用時應用層只需改回傳入整數上限。
create or replace function public.insert_try_on_job_within_quota(
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
     or (p_daily_limit is not null and p_daily_limit <= 0)
     or (p_product_attempt_limit is not null and p_product_attempt_limit <= 0)
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

  -- 固定鎖順序：平台 → Auth 使用者。不可改成相反順序，避免跨使用者死鎖。
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('platform:' || p_since::text, 0)
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('user:' || p_user_id::text || ':' || p_since::text, 0)
  );

  -- 等鎖期間可能已有同 key transaction commit，必須在成本預算檢查前重查。
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

  select coalesce(pg_catalog.sum(budget_reservation), 0::numeric)
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
  if p_daily_limit is not null and v_used_today >= p_daily_limit then
    return pg_catalog.jsonb_build_object(
      'outcome', 'rejected', 'reject_reason', 'daily',
      'used_today', v_used_today, 'product_attempts_today', v_product_attempts
    );
  end if;
  if p_product_attempt_limit is not null and v_product_attempts >= p_product_attempt_limit then
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
