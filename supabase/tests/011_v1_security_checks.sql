-- 套用 001–011 後執行；任一條件不符會 raise exception，整批驗證失敗。
begin;

do $$
declare
  v_table text;
  v_policy_count int;
begin
  foreach v_table in array array[
    'users', 'try_on_jobs', 'try_on_feedback', 'addresses', 'carts', 'cart_items',
    'orders', 'order_items', 'payments', 'inventory_reservations', 'user_roles',    'notification_outbox', 'support_tickets', 'support_messages', 'refund_requests',
    'order_status_events', 'risk_events', 'auth_attempt_events', 'admin_audit_logs',
    'data_retention_policies'
  ] loop
    if not exists (
      select 1 from pg_class join pg_namespace on pg_namespace.oid = pg_class.relnamespace
      where pg_namespace.nspname = 'public' and pg_class.relname = v_table and pg_class.relrowsecurity
    ) then
      raise exception 'RLS is not enabled on public.%', v_table;
    end if;
  end loop;

  foreach v_table in array array[
    'user_roles', 'notification_outbox', 'support_tickets', 'support_messages',
    'refund_requests', 'risk_events', 'auth_attempt_events', 'admin_audit_logs'
  ] loop
    if has_table_privilege('anon', format('public.%I', v_table), 'select')
       or has_table_privilege('authenticated', format('public.%I', v_table), 'select') then
      raise exception 'Sensitive table public.% is exposed to an API role', v_table;
    end if;
  end loop;

  select count(*) into v_policy_count from pg_policies
  where schemaname = 'public' and (policyname like '%_own_rows' or policyname = 'users_own_row');
  if v_policy_count < 15 then raise exception 'Expected own-row defense policies, found %', v_policy_count; end if;

  if exists (select 1 from storage.buckets where id in ('person-uploads', 'try-on-results') and public) then
    raise exception 'Private image bucket is public';
  end if;

  if has_function_privilege('authenticated', 'public.request_order_cancellation(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.request_order_refund(uuid,uuid,text)', 'execute')
     or has_function_privilege('authenticated', 'public.review_refund_request(uuid,uuid,text,numeric,text,text)', 'execute') then
    raise exception 'Sensitive operation RPC is executable by authenticated';
  end if;

  if not has_function_privilege('service_role', 'public.request_order_cancellation(uuid,uuid,text)', 'execute')
     or not has_function_privilege('service_role', 'public.claim_notification_batch(integer)', 'execute') then
    raise exception 'service_role is missing required operation grants';
  end if;
end;
$$;

rollback;
