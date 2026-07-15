-- 010：V0.7 庫存保留。購物車與待付款訂單不再直接扣減實際庫存；僅付款成功時扣減。

create table if not exists public.inventory_reservations (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete restrict,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  quantity int not null check (quantity between 1 and 99),
  status text not null default 'active'
    check (status in ('active', 'completed', 'released')),
  expires_at timestamptz not null,
  completed_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (order_id, variant_id)
);

create index if not exists inventory_reservations_active_variant_idx
  on public.inventory_reservations (variant_id, expires_at)
  where status = 'active';
create index if not exists inventory_reservations_order_idx
  on public.inventory_reservations (order_id);

alter table public.inventory_reservations enable row level security;
revoke all privileges on table public.inventory_reservations from anon, authenticated;
grant all privileges on table public.inventory_reservations to service_role;

-- 升級前的 V0.6／V0.7 會在建立訂單時扣庫存；還沒成功付款的訂單必須先補回，
-- 再將待付款訂單改為保留量。處理中訂單代表已付款，庫存維持原樣。
with quantities_to_restore as (
  select item.variant_id, sum(item.quantity)::int as quantity
  from public.order_items as item
  join public.orders as orders on orders.id = item.order_id
  where orders.status in ('pending_payment', 'payment_failed', 'cancelled', 'expired')
  group by item.variant_id
)
update public.product_variants as variant
set stock_quantity = variant.stock_quantity + restored.quantity, updated_at = now()
from quantities_to_restore as restored
where variant.id = restored.variant_id;

insert into public.inventory_reservations (order_id, variant_id, quantity, expires_at)
select item.order_id, item.variant_id, item.quantity, now() + interval '30 minutes'
from public.order_items as item
join public.orders as orders on orders.id = item.order_id
where orders.status = 'pending_payment'
on conflict (order_id, variant_id) do nothing;

-- 到期的保留會在任何庫存操作前釋放，並將仍待付款的訂單標為逾期。
create or replace function public.release_expired_inventory_reservations()
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_released_count int := 0;
begin
  with released as (
    update public.inventory_reservations
    set status = 'released', released_at = now(), updated_at = now()
    where status = 'active' and expires_at <= now()
    returning order_id
  ), affected_orders as (
    select distinct order_id from released
  )
  update public.orders as orders
  set status = 'expired', updated_at = now()
  where orders.id in (select order_id from affected_orders)
    and orders.status = 'pending_payment';

  get diagnostics v_released_count = row_count;
  return v_released_count;
end;
$$;

-- 回傳可售量（實際庫存 - 尚未釋放的保留量）；只提供後端 service_role 使用。
create or replace function public.get_available_inventory(p_variant_ids uuid[])
returns table (variant_id uuid, available_quantity int)
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.release_expired_inventory_reservations();

  return query
  select
    variant.id,
    greatest(
      variant.stock_quantity - coalesce(sum(reservation.quantity) filter (
        where reservation.status = 'active' and reservation.expires_at > now()
      ), 0),
      0
    )::int as available_quantity
  from public.product_variants as variant
  left join public.inventory_reservations as reservation on reservation.variant_id = variant.id
  where variant.id = any(p_variant_ids)
  group by variant.id, variant.stock_quantity;
end;
$$;

-- 購物車新增／修改／合併與同步都以「可售量」而非實際庫存限制數量。
create or replace function public.add_cart_item(
  p_user_id uuid,
  p_variant_id uuid,
  p_quantity int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart_id uuid;
  v_current int := 0;
  v_target int;
  v_max int;
  v_variant_active boolean;
  v_product_active boolean;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('status', 'invalid_user');
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 99 then
    return jsonb_build_object('status', 'invalid_quantity');
  end if;

  perform public.release_expired_inventory_reservations();
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));

  select
    least(greatest(variant.stock_quantity - coalesce((
      select sum(reservation.quantity)
      from public.inventory_reservations as reservation
      where reservation.variant_id = variant.id
        and reservation.status = 'active'
        and reservation.expires_at > now()
    ), 0), 0), 99),
    variant.is_active,
    product.is_active
  into v_max, v_variant_active, v_product_active
  from public.product_variants as variant
  join public.products as product on product.id = variant.product_id
  where variant.id = p_variant_id
  for update of variant;

  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if not v_variant_active or not v_product_active or v_max < 1 then
    return jsonb_build_object('status', 'unavailable', 'maxQuantity', greatest(v_max, 0));
  end if;

  insert into public.carts (user_id)
  values (p_user_id)
  on conflict (user_id) do update set updated_at = now()
  returning id into v_cart_id;

  select quantity into v_current
  from public.cart_items
  where cart_id = v_cart_id and variant_id = p_variant_id
  for update;
  v_current := coalesce(v_current, 0);
  v_target := least(v_current + p_quantity, v_max);

  insert into public.cart_items (cart_id, variant_id, quantity)
  values (v_cart_id, p_variant_id, v_target)
  on conflict (cart_id, variant_id) do update
    set quantity = excluded.quantity, updated_at = now();
  update public.carts set updated_at = now() where id = v_cart_id;

  return jsonb_build_object('status', 'success', 'quantity', v_target, 'maxQuantity', v_max,
    'adjusted', v_target <> v_current + p_quantity);
end;
$$;

create or replace function public.set_cart_item_quantity(
  p_user_id uuid,
  p_variant_id uuid,
  p_quantity int
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart_id uuid;
  v_max int;
  v_variant_active boolean;
  v_product_active boolean;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then return jsonb_build_object('status', 'invalid_user'); end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 99 then return jsonb_build_object('status', 'invalid_quantity'); end if;

  perform public.release_expired_inventory_reservations();
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  select id into v_cart_id from public.carts where user_id = p_user_id;
  if v_cart_id is null or not exists (
    select 1 from public.cart_items where cart_id = v_cart_id and variant_id = p_variant_id
  ) then return jsonb_build_object('status', 'not_found'); end if;

  select
    least(greatest(variant.stock_quantity - coalesce((
      select sum(reservation.quantity) from public.inventory_reservations as reservation
      where reservation.variant_id = variant.id and reservation.status = 'active' and reservation.expires_at > now()
    ), 0), 0), 99), variant.is_active, product.is_active
  into v_max, v_variant_active, v_product_active
  from public.product_variants as variant
  join public.products as product on product.id = variant.product_id
  where variant.id = p_variant_id
  for update of variant;

  if not found then return jsonb_build_object('status', 'not_found'); end if;
  if not v_variant_active or not v_product_active or v_max < 1 then
    return jsonb_build_object('status', 'unavailable', 'maxQuantity', greatest(v_max, 0));
  end if;
  if p_quantity > v_max then return jsonb_build_object('status', 'exceeds_stock', 'maxQuantity', v_max); end if;

  update public.cart_items set quantity = p_quantity, updated_at = now()
  where cart_id = v_cart_id and variant_id = p_variant_id;
  update public.carts set updated_at = now() where id = v_cart_id;
  return jsonb_build_object('status', 'success', 'quantity', p_quantity, 'maxQuantity', v_max);
end;
$$;

create or replace function public.merge_guest_cart(
  p_user_id uuid,
  p_guest_cart_id uuid,
  p_items jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart_id uuid;
  v_inserted_receipt uuid;
  v_item record;
  v_current int;
  v_target int;
  v_max int;
  v_variant_active boolean;
  v_product_active boolean;
  v_adjusted int := 0;
  v_skipped int := 0;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then return jsonb_build_object('status', 'invalid_user'); end if;
  if p_guest_cart_id is null or p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) > 50 then return jsonb_build_object('status', 'invalid_input'); end if;

  perform public.release_expired_inventory_reservations();
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  insert into public.carts (user_id) values (p_user_id)
  on conflict (user_id) do update set updated_at = now()
  returning id into v_cart_id;
  insert into public.cart_merge_receipts (cart_id, user_id, guest_cart_id)
  values (v_cart_id, p_user_id, p_guest_cart_id)
  on conflict (user_id, guest_cart_id) do nothing
  returning id into v_inserted_receipt;
  if v_inserted_receipt is null then
    return jsonb_build_object('status', 'success', 'alreadyMerged', true, 'adjusted', 0, 'skipped', 0);
  end if;

  for v_item in
    with raw_items as (
      select
        case when value->>'variantId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (value->>'variantId')::uuid end as variant_id,
        case when value->>'quantity' ~ '^[0-9]{1,2}$' then (value->>'quantity')::int end as quantity
      from jsonb_array_elements(p_items)
    )
    select variant_id, sum(quantity)::int as quantity
    from raw_items where variant_id is not null and quantity between 1 and 99
    group by variant_id order by variant_id
  loop
    select
      least(greatest(variant.stock_quantity - coalesce((
        select sum(reservation.quantity) from public.inventory_reservations as reservation
        where reservation.variant_id = variant.id and reservation.status = 'active' and reservation.expires_at > now()
      ), 0), 0), 99), variant.is_active, product.is_active
    into v_max, v_variant_active, v_product_active
    from public.product_variants as variant
    join public.products as product on product.id = variant.product_id
    where variant.id = v_item.variant_id
    for update of variant;
    if not found or not v_variant_active or not v_product_active or v_max < 1 then
      v_skipped := v_skipped + 1;
      continue;
    end if;
    select quantity into v_current from public.cart_items
    where cart_id = v_cart_id and variant_id = v_item.variant_id for update;
    v_current := coalesce(v_current, 0);
    v_target := least(v_current + v_item.quantity, v_max);
    if v_target <> v_current + v_item.quantity then v_adjusted := v_adjusted + 1; end if;
    insert into public.cart_items (cart_id, variant_id, quantity)
    values (v_cart_id, v_item.variant_id, v_target)
    on conflict (cart_id, variant_id) do update set quantity = excluded.quantity, updated_at = now();
  end loop;
  update public.carts set updated_at = now() where id = v_cart_id;
  return jsonb_build_object('status', 'success', 'alreadyMerged', false, 'adjusted', v_adjusted, 'skipped', v_skipped);
end;
$$;

create or replace function public.reconcile_cart_stock(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare v_changed int;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then return 0; end if;
  perform public.release_expired_inventory_reservations();
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  update public.cart_items as item
  set quantity = least(99, greatest(0, variant.stock_quantity - coalesce((
    select sum(reservation.quantity) from public.inventory_reservations as reservation
    where reservation.variant_id = variant.id and reservation.status = 'active' and reservation.expires_at > now()
  ), 0))), updated_at = now()
  from public.carts as cart, public.product_variants as variant, public.products as product
  where item.cart_id = cart.id and cart.user_id = p_user_id and item.variant_id = variant.id
    and variant.product_id = product.id and variant.is_active and product.is_active
    and item.quantity > least(99, greatest(0, variant.stock_quantity - coalesce((
      select sum(reservation.quantity) from public.inventory_reservations as reservation
      where reservation.variant_id = variant.id and reservation.status = 'active' and reservation.expires_at > now()
    ), 0)));
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

-- 建立訂單只新增保留紀錄，不扣減 product_variants.stock_quantity。
create or replace function public.create_order_from_cart(
  p_user_id uuid,
  p_shipping_method_code text,
  p_recipient_name text,
  p_recipient_phone text,
  p_recipient_address text,
  p_idempotency_key uuid
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_cart_id uuid;
  v_existing_order public.orders%rowtype;
  v_shipping public.shipping_methods%rowtype;
  v_order public.orders%rowtype;
  v_item record;
  v_subtotal numeric(12, 2) := 0;
  v_available_quantity int;
  v_recipient_name text := btrim(coalesce(p_recipient_name, ''));
  v_recipient_phone text := regexp_replace(btrim(coalesce(p_recipient_phone, '')), '[[:space:]()-]', '', 'g');
  v_recipient_address text := btrim(coalesce(p_recipient_address, ''));
  v_has_items boolean := false;
begin
  if p_user_id is null or p_idempotency_key is null or not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('status', 'invalid_user');
  end if;
  if char_length(v_recipient_name) not between 1 and 80 or char_length(v_recipient_address) not between 5 and 300
     or v_recipient_phone !~ '^(?:09[0-9]{8}|\+8869[0-9]{8})$'
     or coalesce(p_shipping_method_code, '') !~ '^[a-z0-9_]{1,40}$' then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform public.release_expired_inventory_reservations();
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));
  select * into v_existing_order from public.orders where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object('status', 'success', 'orderId', v_existing_order.id,
      'orderNumber', v_existing_order.order_number, 'reused', true);
  end if;
  select * into v_shipping from public.shipping_methods where code = p_shipping_method_code and is_active for share;
  if not found then return jsonb_build_object('status', 'shipping_method_unavailable'); end if;
  select id into v_cart_id from public.carts where user_id = p_user_id for update;
  if not found then return jsonb_build_object('status', 'empty_cart'); end if;

  for v_item in
    select item.variant_id, item.quantity, variant.product_id, variant.size, variant.stock_quantity,
      variant.is_active as variant_is_active, product.name as product_name, product.price as unit_price,
      product.image_url, product.is_active as product_is_active
    from public.cart_items as item
    join public.product_variants as variant on variant.id = item.variant_id
    join public.products as product on product.id = variant.product_id
    where item.cart_id = v_cart_id
    order by item.variant_id
    for update of item, variant
  loop
    v_has_items := true;
    if not v_item.product_is_active or not v_item.variant_is_active then
      return jsonb_build_object('status', 'cart_unavailable', 'variantId', v_item.variant_id);
    end if;
    select greatest(v_item.stock_quantity - coalesce(sum(reservation.quantity), 0), 0)::int
    into v_available_quantity
    from public.inventory_reservations as reservation
    where reservation.variant_id = v_item.variant_id and reservation.status = 'active' and reservation.expires_at > now();
    if v_available_quantity < v_item.quantity then
      return jsonb_build_object('status', 'insufficient_stock', 'variantId', v_item.variant_id,
        'availableQuantity', v_available_quantity);
    end if;
    v_subtotal := v_subtotal + v_item.unit_price * v_item.quantity;
  end loop;
  if not v_has_items then return jsonb_build_object('status', 'empty_cart'); end if;

  insert into public.orders (
    user_id, recipient_name, recipient_phone, recipient_address, shipping_method_code,
    shipping_method_name, shipping_fee, subtotal, total, idempotency_key
  ) values (
    p_user_id, v_recipient_name, v_recipient_phone, v_recipient_address, v_shipping.code,
    v_shipping.name, v_shipping.fee, v_subtotal, v_subtotal + v_shipping.fee, p_idempotency_key
  ) returning * into v_order;

  for v_item in
    select item.variant_id, item.quantity, variant.product_id, variant.size, product.name as product_name,
      product.price as unit_price, product.image_url
    from public.cart_items as item
    join public.product_variants as variant on variant.id = item.variant_id
    join public.products as product on product.id = variant.product_id
    where item.cart_id = v_cart_id
    order by item.variant_id
  loop
    insert into public.order_items (
      order_id, product_id, variant_id, product_name, variant_size, image_url, unit_price, quantity, line_subtotal
    ) values (
      v_order.id, v_item.product_id, v_item.variant_id, v_item.product_name, v_item.size,
      v_item.image_url, v_item.unit_price, v_item.quantity, v_item.unit_price * v_item.quantity
    );
    insert into public.inventory_reservations (order_id, variant_id, quantity, expires_at)
    values (v_order.id, v_item.variant_id, v_item.quantity, now() + interval '30 minutes');
  end loop;
  delete from public.cart_items where cart_id = v_cart_id;
  update public.carts set updated_at = now() where id = v_cart_id;
  return jsonb_build_object('status', 'success', 'orderId', v_order.id,
    'orderNumber', v_order.order_number, 'reused', false);
end;
$$;

-- Webhook 成功才扣庫存並完成保留；失敗、取消、逾期只釋放保留。整段維持單一交易與冪等事件鍵。
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
  v_reservation record;
  v_failure_reason text := nullif(btrim(coalesce(p_failure_reason, '')), '');
  v_next_order_status text;
  v_ignored boolean := false;
  v_has_reservation boolean := false;
begin
  if p_event_id is null or p_order_id is null or coalesce(p_transaction_id, '') !~ '^MOCK-[0-9]{13}-[0-9A-F]{12}$'
     or coalesce(p_result, '') not in ('succeeded', 'failed', 'cancelled', 'expired') or p_payload is null
     or (v_failure_reason is not null and char_length(v_failure_reason) > 300) then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform public.release_expired_inventory_reservations();
  select * into v_order from public.orders where id = p_order_id for update;
  if not found then return jsonb_build_object('status', 'missing_order'); end if;
  select * into v_existing_event from public.payment_webhook_events where event_id = p_event_id;
  if found then
    select * into v_payment from public.payments where id = v_existing_event.payment_id;
    if v_existing_event.order_id <> p_order_id or v_existing_event.result <> p_result or v_payment.transaction_id <> p_transaction_id then
      return jsonb_build_object('status', 'event_conflict');
    end if;
    return jsonb_build_object('status', 'success', 'reused', true, 'ignored', v_existing_event.ignored,
      'orderStatus', v_order.status, 'paymentStatus', v_payment.status);
  end if;

  select * into v_payment from public.payments where order_id = p_order_id for update;
  if not found then
    insert into public.payments (order_id, user_id, transaction_id)
    values (v_order.id, v_order.user_id, p_transaction_id) returning * into v_payment;
  elsif v_payment.transaction_id <> p_transaction_id then
    return jsonb_build_object('status', 'transaction_conflict');
  end if;

  v_ignored := v_order.status <> 'pending_payment' or v_payment.status <> 'pending';
  if not v_ignored and p_result = 'succeeded' then
    for v_reservation in
      select reservation.id, reservation.status, reservation.expires_at, reservation.quantity,
        variant.id as variant_id, variant.stock_quantity
      from public.inventory_reservations as reservation
      join public.product_variants as variant on variant.id = reservation.variant_id
      where reservation.order_id = v_order.id
      order by reservation.variant_id
      for update of reservation, variant
    loop
      v_has_reservation := true;
      if v_reservation.status <> 'active' or v_reservation.expires_at <= now() then
        return jsonb_build_object('status', 'reservation_unavailable');
      end if;
      if v_reservation.stock_quantity < v_reservation.quantity then
        return jsonb_build_object('status', 'insufficient_stock');
      end if;
    end loop;
    if not v_has_reservation then return jsonb_build_object('status', 'reservation_unavailable'); end if;
  end if;

  insert into public.payment_webhook_events (
    event_id, payment_id, order_id, result, failure_reason, payload, ignored
  ) values (p_event_id, v_payment.id, v_order.id, p_result, v_failure_reason, p_payload, v_ignored);
  if v_ignored then
    if v_order.status = 'expired' and v_payment.status = 'pending' then
      update public.payments set status = 'expired', failure_reason = '庫存保留已逾期', updated_at = now()
      where id = v_payment.id returning * into v_payment;
    end if;
    return jsonb_build_object('status', 'success', 'reused', false, 'ignored', true,
      'orderStatus', v_order.status, 'paymentStatus', v_payment.status);
  end if;

  if p_result = 'succeeded' then
    v_next_order_status := 'processing';
    v_failure_reason := null;
    update public.product_variants as variant
    set stock_quantity = variant.stock_quantity - reservation.quantity, updated_at = now()
    from public.inventory_reservations as reservation
    where reservation.order_id = v_order.id and reservation.variant_id = variant.id and reservation.status = 'active';
    update public.inventory_reservations
    set status = 'completed', completed_at = now(), updated_at = now()
    where order_id = v_order.id and status = 'active';
  elsif p_result = 'failed' then
    v_next_order_status := 'payment_failed';
    v_failure_reason := coalesce(v_failure_reason, '模擬付款失敗');
    update public.inventory_reservations set status = 'released', released_at = now(), updated_at = now()
    where order_id = v_order.id and status = 'active';
  elsif p_result = 'cancelled' then
    v_next_order_status := 'cancelled';
    v_failure_reason := coalesce(v_failure_reason, '使用者取消模擬付款');
    update public.inventory_reservations set status = 'released', released_at = now(), updated_at = now()
    where order_id = v_order.id and status = 'active';
  else
    v_next_order_status := 'expired';
    v_failure_reason := coalesce(v_failure_reason, '模擬付款逾期');
    update public.inventory_reservations set status = 'released', released_at = now(), updated_at = now()
    where order_id = v_order.id and status = 'active';
  end if;

  update public.payments
  set status = p_result, failure_reason = v_failure_reason,
    paid_at = case when p_result = 'succeeded' then now() else null end, updated_at = now()
  where id = v_payment.id returning * into v_payment;
  update public.orders set status = v_next_order_status, updated_at = now()
  where id = v_order.id returning * into v_order;
  return jsonb_build_object('status', 'success', 'reused', false, 'ignored', false,
    'orderStatus', v_order.status, 'paymentStatus', v_payment.status);
end;
$$;

revoke execute on function public.release_expired_inventory_reservations() from public, anon, authenticated;
revoke execute on function public.get_available_inventory(uuid[]) from public, anon, authenticated;
revoke execute on function public.add_cart_item(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.set_cart_item_quantity(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.merge_guest_cart(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.reconcile_cart_stock(uuid) from public, anon, authenticated;
revoke execute on function public.create_order_from_cart(uuid, text, text, text, text, uuid) from public, anon, authenticated;
revoke execute on function public.process_mock_payment_webhook(uuid, uuid, text, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.release_expired_inventory_reservations() to service_role;
grant execute on function public.get_available_inventory(uuid[]) to service_role;
grant execute on function public.add_cart_item(uuid, uuid, int) to service_role;
grant execute on function public.set_cart_item_quantity(uuid, uuid, int) to service_role;
grant execute on function public.merge_guest_cart(uuid, uuid, jsonb) to service_role;
grant execute on function public.reconcile_cart_stock(uuid) to service_role;
grant execute on function public.create_order_from_cart(uuid, text, text, text, text, uuid) to service_role;
grant execute on function public.process_mock_payment_webhook(uuid, uuid, text, text, text, jsonb) to service_role;
