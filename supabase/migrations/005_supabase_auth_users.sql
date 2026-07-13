-- 005：V0.2 正式會員登入。
-- 保留既有匿名測試資料，但新的 public.users 只能對應 auth.users，正式流程不搬移匿名資料。

-- Auth 建立使用者或更新 email 時，同步最小 public profile。
create or replace function public.sync_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

revoke execute on function public.sync_auth_user() from public, anon, authenticated;

drop trigger if exists sync_auth_user_on_change on auth.users;
create trigger sync_auth_user_on_change
  after insert or update of email on auth.users
  for each row execute function public.sync_auth_user();

-- 補齊 migration 上線前已存在的 Auth 帳戶。
insert into public.users (id, email)
select id, email from auth.users
on conflict (id) do update set email = excluded.email;

-- NOT VALID 只豁免既有匿名測試列；此 constraint 建立後的每一筆新增／更新都必須
-- 對應 auth.users.id，因此正式 public.users.id 以 Supabase Auth 為唯一來源。
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'users_id_auth_users_fkey'
      and conrelid = 'public.users'::regclass
  ) then
    alter table public.users
      add constraint users_id_auth_users_fkey
      foreign key (id) references auth.users (id)
      not valid;
  end if;
  if not exists (
    select 1
    from public.users as public_user
    left join auth.users as auth_user on auth_user.id = public_user.id
    where auth_user.id is null
  ) then
    alter table public.users validate constraint users_id_auth_users_fkey;
  end if;
end;
$$;

-- 匿名資料表保留測試資料，但移除建立匿名身分的唯一 DB 入口。
drop function if exists public.create_anonymous_session(
  text, text, timestamptz, timestamptz, int
);

-- 移除 migration 004 的匿名來源版 RPC，避免後端誤走舊入口。
drop function if exists public.insert_try_on_job_within_quota(
  uuid, text, uuid, text, text, text, numeric, numeric, timestamptz, int, int, int, numeric
);

create or replace function public.insert_try_on_job_within_quota(
  p_user_id uuid,
  p_product_id uuid,
  p_person_image_url text,
  p_garment_image_url text,
  p_provider text,
  p_cost_estimate numeric,
  p_budget_reservation numeric,
  p_since timestamptz,
  p_daily_limit int,
  p_product_attempt_limit int,
  p_platform_daily_budget numeric
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used_today int;
  v_product_attempts int;
  v_platform_reserved numeric;
  v_job public.try_on_jobs;
begin
  if not exists (select 1 from auth.users where id = p_user_id)
     or p_cost_estimate < 0
     or p_budget_reservation < p_cost_estimate then
    raise exception 'invalid authenticated user or cost-control input';
  end if;

  -- 固定鎖順序：平台 → Auth 使用者，避免 deadlock 並保證額度與 insert 原子化。
  perform pg_advisory_xact_lock(hashtextextended('platform:' || p_since::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('user:' || p_user_id::text || ':' || p_since::text, 0));

  select coalesce(sum(budget_reservation), 0) into v_platform_reserved
  from public.try_on_jobs
  where created_at >= p_since;

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
    (user_id, product_id, person_image_url, garment_image_url,
     provider, status, cost_estimate, budget_reservation, retry_count)
  values
    (p_user_id, p_product_id, p_person_image_url, p_garment_image_url,
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
  uuid, uuid, text, text, text, numeric, numeric, timestamptz, int, int, numeric
) from public, anon, authenticated;
grant execute on function public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, numeric, timestamptz, int, int, numeric
) to service_role;
