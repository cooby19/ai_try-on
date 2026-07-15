-- 007：V0.5 真實購物車、尺寸規格與跨裝置持久化。
-- 所有購物車操作仍只經過已驗證的後端 API，再由 service_role 呼叫下列函式。

alter table public.products
  add column if not exists is_active boolean not null default true;

create table if not exists public.product_variants (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references public.products (id) on delete restrict,
  size text not null check (char_length(size) between 1 and 40),
  stock_quantity int not null default 0 check (stock_quantity >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (product_id, size)
);

create index if not exists product_variants_product_idx
  on public.product_variants (product_id, is_active);

create table if not exists public.carts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id)
);

create table if not exists public.cart_items (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts (id) on delete cascade,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  quantity int not null check (quantity between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (cart_id, variant_id)
);

create index if not exists cart_items_cart_idx on public.cart_items (cart_id, created_at);

-- 網路可能在 DB 已合併後、瀏覽器收到回應前中斷；以 guest_cart_id 記錄已處理批次，
-- 讓同一批 localStorage 資料重送時不會再次累加。
create table if not exists public.cart_merge_receipts (
  id uuid primary key default gen_random_uuid(),
  cart_id uuid not null references public.carts (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  guest_cart_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, guest_cart_id)
);

-- 由既有尺寸表建立可購買規格。既有三件種子商品的每個尺寸預設 20 件；
-- 沒有尺寸表的商品建立「單一尺寸」，避免升級後無法加入購物車。
insert into public.product_variants (product_id, size, stock_quantity)
select product.id, size_list.size, 20
from public.products as product
cross join lateral (
  select size_key as size
  from jsonb_object_keys(coalesce(product.size_chart, '{}'::jsonb)) as keys(size_key)
  union all
  select '單一尺寸'
  where not exists (
    select 1 from jsonb_object_keys(coalesce(product.size_chart, '{}'::jsonb))
  )
) as size_list
on conflict (product_id, size) do nothing;

alter table public.product_variants enable row level security;
alter table public.carts enable row level security;
alter table public.cart_items enable row level security;
alter table public.cart_merge_receipts enable row level security;

grant all privileges on table public.product_variants to service_role;
grant all privileges on table public.carts to service_role;
grant all privileges on table public.cart_items to service_role;
grant all privileges on table public.cart_merge_receipts to service_role;

create or replace function public.add_cart_item(
  p_user_id uuid,
  p_variant_id uuid,
  p_quantity int
) returns jsonb
language plpgsql
security definer
set search_path = public
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

  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));

  select least(variant.stock_quantity, 99), variant.is_active, product.is_active
  into v_max, v_variant_active, v_product_active
  from public.product_variants as variant
  join public.products as product on product.id = variant.product_id
  where variant.id = p_variant_id
  for update of variant;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
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
  return jsonb_build_object(
    'status', 'success',
    'quantity', v_target,
    'maxQuantity', v_max,
    'adjusted', v_target <> v_current + p_quantity
  );
end;
$$;

create or replace function public.set_cart_item_quantity(
  p_user_id uuid,
  p_variant_id uuid,
  p_quantity int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cart_id uuid;
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

  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  select id into v_cart_id from public.carts where user_id = p_user_id;
  if v_cart_id is null or not exists (
    select 1 from public.cart_items
    where cart_id = v_cart_id and variant_id = p_variant_id
  ) then
    return jsonb_build_object('status', 'not_found');
  end if;

  select least(variant.stock_quantity, 99), variant.is_active, product.is_active
  into v_max, v_variant_active, v_product_active
  from public.product_variants as variant
  join public.products as product on product.id = variant.product_id
  where variant.id = p_variant_id
  for update of variant;

  if not found then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not v_variant_active or not v_product_active or v_max < 1 then
    return jsonb_build_object('status', 'unavailable', 'maxQuantity', greatest(v_max, 0));
  end if;
  if p_quantity > v_max then
    return jsonb_build_object('status', 'exceeds_stock', 'maxQuantity', v_max);
  end if;

  update public.cart_items
  set quantity = p_quantity, updated_at = now()
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
set search_path = public
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
  if not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('status', 'invalid_user');
  end if;
  if p_guest_cart_id is null or p_items is null or jsonb_typeof(p_items) is distinct from 'array'
     or jsonb_array_length(p_items) > 50 then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  insert into public.carts (user_id)
  values (p_user_id)
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
        case
          when value->>'variantId' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          then (value->>'variantId')::uuid
        end as variant_id,
        case
          when value->>'quantity' ~ '^[0-9]{1,2}$' then (value->>'quantity')::int
        end as quantity
      from jsonb_array_elements(p_items)
    )
    select variant_id, sum(quantity)::int as quantity
    from raw_items
    where variant_id is not null and quantity between 1 and 99
    group by variant_id
  loop
    select least(variant.stock_quantity, 99), variant.is_active, product.is_active
    into v_max, v_variant_active, v_product_active
    from public.product_variants as variant
    join public.products as product on product.id = variant.product_id
    where variant.id = v_item.variant_id
    for update of variant;

    if not found or not v_variant_active or not v_product_active or v_max < 1 then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    select quantity into v_current
    from public.cart_items
    where cart_id = v_cart_id and variant_id = v_item.variant_id
    for update;
    v_current := coalesce(v_current, 0);
    v_target := least(v_current + v_item.quantity, v_max);
    if v_target <> v_current + v_item.quantity then
      v_adjusted := v_adjusted + 1;
    end if;

    insert into public.cart_items (cart_id, variant_id, quantity)
    values (v_cart_id, v_item.variant_id, v_target)
    on conflict (cart_id, variant_id) do update
      set quantity = excluded.quantity, updated_at = now();
  end loop;

  update public.carts set updated_at = now() where id = v_cart_id;
  return jsonb_build_object(
    'status', 'success', 'alreadyMerged', false,
    'adjusted', v_adjusted, 'skipped', v_skipped
  );
end;
$$;

-- 只下修仍可售且仍有庫存的品項；缺貨／下架品項保留，讓 UI 顯示並由使用者移除。
create or replace function public.reconcile_cart_stock(p_user_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed int;
begin
  if not exists (select 1 from auth.users where id = p_user_id) then
    return 0;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));

  update public.cart_items as item
  set quantity = least(variant.stock_quantity, 99), updated_at = now()
  from public.carts as cart, public.product_variants as variant, public.products as product
  where item.cart_id = cart.id
    and cart.user_id = p_user_id
    and item.variant_id = variant.id
    and variant.product_id = product.id
    and variant.is_active
    and product.is_active
    and variant.stock_quantity > 0
    and item.quantity > least(variant.stock_quantity, 99);
  get diagnostics v_changed = row_count;
  return v_changed;
end;
$$;

revoke execute on function public.add_cart_item(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.set_cart_item_quantity(uuid, uuid, int) from public, anon, authenticated;
revoke execute on function public.merge_guest_cart(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.reconcile_cart_stock(uuid) from public, anon, authenticated;
grant execute on function public.add_cart_item(uuid, uuid, int) to service_role;
grant execute on function public.set_cart_item_quantity(uuid, uuid, int) to service_role;
grant execute on function public.merge_guest_cart(uuid, uuid, jsonb) to service_role;
grant execute on function public.reconcile_cart_stock(uuid) to service_role;
