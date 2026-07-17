-- 套用最新 Try-On migration 後執行；只做 metadata/security 驗證，不呼叫真實 Provider。
begin;

do $$
declare
  v_new_rpc_oid oid;
begin
  if not exists (
    select 1
    from pg_class
    join pg_namespace on pg_namespace.oid = pg_class.relnamespace
    where pg_namespace.nspname = 'public'
      and pg_class.relname = 'try_on_jobs'
      and pg_class.relrowsecurity
  ) then
    raise exception 'RLS is not enabled on public.try_on_jobs';
  end if;

  select p.oid
    into v_new_rpc_oid
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname = 'insert_try_on_job_within_quota'
    and p.pronargs = 16
    and p.prorettype = 'jsonb'::regtype
  order by p.oid desc
  limit 1;

  if v_new_rpc_oid is null then
    raise exception 'new idempotent try-on RPC is missing; apply migration 20260717041002_try_on_reproducibility_idempotency.sql before running this test';
  end if;
  if has_function_privilege('anon', v_new_rpc_oid, 'execute')
     or has_function_privilege('authenticated', v_new_rpc_oid, 'execute') then
    raise exception 'new SECURITY DEFINER RPC is exposed to an API role';
  end if;
  if not has_function_privilege('service_role', v_new_rpc_oid, 'execute') then
    raise exception 'service_role is missing new try-on RPC execute privilege';
  end if;

  if to_regprocedure('public.insert_try_on_job_within_quota(uuid,uuid,text,text,text,numeric,timestamptz,integer,integer)') is not null
     or to_regprocedure('public.insert_try_on_job_within_quota(uuid,text,uuid,text,text,text,numeric,numeric,timestamptz,integer,integer,integer,numeric)') is not null
     or to_regprocedure('public.insert_try_on_job_within_quota(uuid,uuid,text,text,text,numeric,numeric,timestamptz,integer,integer,numeric)') is not null then
    raise exception 'legacy try-on RPC overload still exists';
  end if;

  if not exists (
    select 1 from pg_indexes
    where schemaname = 'public'
      and tablename = 'try_on_jobs'
      and indexname = 'try_on_jobs_user_idempotency_key_uidx'
      and indexdef ilike '%unique%'
      and indexdef ilike '%where (idempotency_key is not null)%'
  ) then
    raise exception 'partial unique idempotency index is missing or malformed';
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.try_on_jobs'::regclass
      and tgname = 'preserve_try_on_job_creation_snapshot'
      and not tgisinternal
  ) then
    raise exception 'snapshot immutability trigger is missing';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'try_on_jobs'
      and column_name in (
        'config_snapshot', 'seed', 'started_at', 'provider_submitted_at',
        'completed_at', 'last_polled_at', 'error_type', 'error_code',
        'provider_http_status', 'idempotency_key', 'request_fingerprint'
      )
  ) <> 11 then
    raise exception 'one or more try-on reproducibility columns are missing';
  end if;
end;
$$;

rollback;
