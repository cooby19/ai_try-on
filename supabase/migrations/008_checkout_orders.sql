-- 008：V0.6 結帳、地址簿與待付款訂單。
-- 所有資料讀寫都經過已驗證的後端 API；建立訂單則統一由下方 RPC 在一個交易中完成。

create table if not exists public.addresses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null default '常用地址' check (char_length(label) between 1 and 40),
  recipient_name text not null check (char_length(recipient_name) between 1 and 80),
  recipient_phone text not null check (char_length(recipient_phone) between 8 and 20),
  recipient_address text not null check (char_length(recipient_address) between 5 and 300),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists addresses_user_updated_idx
  on public.addresses (user_id, updated_at desc);

create table if not exists public.shipping_methods (
  code text primary key check (code ~ '^[a-z0-9_]{1,40}$'),
  name text not null check (char_length(name) between 1 and 80),
  fee numeric(10, 2) not null check (fee >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.shipping_methods (code, name, fee)
values
  ('standard_delivery', '標準宅配', 100),
  ('express_delivery', '快速宅配', 180)
on conflict (code) do nothing;

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  order_number text not null unique default (
    'ORD-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12))
  ),
  user_id uuid not null references auth.users (id) on delete restrict,
  status text not null default 'pending_payment'
    check (status in ('pending_payment', 'paid', 'cancelled')),
  recipient_name text not null check (char_length(recipient_name) between 1 and 80),
  recipient_phone text not null check (char_length(recipient_phone) between 8 and 20),
  recipient_address text not null check (char_length(recipient_address) between 5 and 300),
  shipping_method_code text not null check (char_length(shipping_method_code) between 1 and 40),
  shipping_method_name text not null check (char_length(shipping_method_name) between 1 and 80),
  shipping_fee numeric(10, 2) not null check (shipping_fee >= 0),
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  total numeric(12, 2) not null check (total = subtotal + shipping_fee),
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, idempotency_key)
);

create index if not exists orders_user_created_idx
  on public.orders (user_id, created_at desc);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete restrict,
  variant_id uuid not null references public.product_variants (id) on delete restrict,
  product_name text not null check (char_length(product_name) between 1 and 200),
  variant_size text not null check (char_length(variant_size) between 1 and 40),
  image_url text not null,
  unit_price numeric(10, 2) not null check (unit_price >= 0),
  quantity int not null check (quantity between 1 and 99),
  line_subtotal numeric(12, 2) not null check (line_subtotal = unit_price * quantity),
  created_at timestamptz not null default now()
);

create index if not exists order_items_order_idx on public.order_items (order_id, created_at);
create index if not exists order_items_product_idx on public.order_items (product_id);
create index if not exists order_items_variant_idx on public.order_items (variant_id);

alter table public.addresses enable row level security;
alter table public.shipping_methods enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

grant all privileges on table public.addresses to service_role;
grant all privileges on table public.shipping_methods to service_role;
grant all privileges on table public.orders to service_role;
grant all privileges on table public.order_items to service_role;

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
  v_recipient_name text := btrim(coalesce(p_recipient_name, ''));
  v_recipient_phone text := regexp_replace(btrim(coalesce(p_recipient_phone, '')), '[[:space:]()-]', '', 'g');
  v_recipient_address text := btrim(coalesce(p_recipient_address, ''));
  v_has_items boolean := false;
begin
  if p_user_id is null or p_idempotency_key is null
     or not exists (select 1 from auth.users where id = p_user_id) then
    return jsonb_build_object('status', 'invalid_user');
  end if;

  if char_length(v_recipient_name) not between 1 and 80
     or char_length(v_recipient_address) not between 5 and 300
     or v_recipient_phone !~ '^(?:09[0-9]{8}|\+8869[0-9]{8})$'
     or coalesce(p_shipping_method_code, '') !~ '^[a-z0-9_]{1,40}$' then
    return jsonb_build_object('status', 'invalid_input');
  end if;

  -- 購物車異動與結帳固定先鎖同一把 cart lock，再鎖 checkout lock，避免交錯更新。
  perform pg_advisory_xact_lock(hashtextextended('cart:' || p_user_id::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('checkout:' || p_user_id::text, 0));

  select * into v_existing_order
  from public.orders
  where user_id = p_user_id and idempotency_key = p_idempotency_key;
  if found then
    return jsonb_build_object(
      'status', 'success', 'orderId', v_existing_order.id,
      'orderNumber', v_existing_order.order_number, 'reused', true
    );
  end if;

  select * into v_shipping
  from public.shipping_methods
  where code = p_shipping_method_code and is_active
  for share;
  if not found then
    return jsonb_build_object('status', 'shipping_method_unavailable');
  end if;

  select id into v_cart_id
  from public.carts
  where user_id = p_user_id
  for update;
  if not found then
    return jsonb_build_object('status', 'empty_cart');
  end if;

  -- 先依規格 ID 取得一致的列鎖順序，確認可售與庫存；任何失敗都不建立訂單。
  for v_item in
    select
      item.variant_id,
      item.quantity,
      variant.product_id,
      variant.size,
      variant.stock_quantity,
      variant.is_active as variant_is_active,
      product.name as product_name,
      product.price as unit_price,
      product.image_url,
      product.is_active as product_is_active
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
    if v_item.stock_quantity < v_item.quantity then
      return jsonb_build_object(
        'status', 'insufficient_stock', 'variantId', v_item.variant_id,
        'availableQuantity', v_item.stock_quantity
      );
    end if;
    v_subtotal := v_subtotal + v_item.unit_price * v_item.quantity;
  end loop;

  if not v_has_items then
    return jsonb_build_object('status', 'empty_cart');
  end if;

  insert into public.orders (
    user_id, recipient_name, recipient_phone, recipient_address,
    shipping_method_code, shipping_method_name, shipping_fee,
    subtotal, total, idempotency_key
  ) values (
    p_user_id, v_recipient_name, v_recipient_phone, v_recipient_address,
    v_shipping.code, v_shipping.name, v_shipping.fee,
    v_subtotal, v_subtotal + v_shipping.fee, p_idempotency_key
  ) returning * into v_order;

  -- 規格列已在上方鎖住，第二次讀取只用來寫入不可變的訂單快照與扣減庫存。
  for v_item in
    select
      item.variant_id,
      item.quantity,
      variant.product_id,
      variant.size,
      product.name as product_name,
      product.price as unit_price,
      product.image_url
    from public.cart_items as item
    join public.product_variants as variant on variant.id = item.variant_id
    join public.products as product on product.id = variant.product_id
    where item.cart_id = v_cart_id
    order by item.variant_id
  loop
    insert into public.order_items (
      order_id, product_id, variant_id, product_name, variant_size,
      image_url, unit_price, quantity, line_subtotal
    ) values (
      v_order.id, v_item.product_id, v_item.variant_id, v_item.product_name, v_item.size,
      v_item.image_url, v_item.unit_price, v_item.quantity, v_item.unit_price * v_item.quantity
    );

    update public.product_variants
    set stock_quantity = stock_quantity - v_item.quantity, updated_at = now()
    where id = v_item.variant_id;
  end loop;

  delete from public.cart_items where cart_id = v_cart_id;
  update public.carts set updated_at = now() where id = v_cart_id;

  return jsonb_build_object(
    'status', 'success', 'orderId', v_order.id,
    'orderNumber', v_order.order_number, 'reused', false
  );
end;
$$;

revoke execute on function public.create_order_from_cart(uuid, text, text, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.create_order_from_cart(uuid, text, text, text, text, uuid)
  to service_role;
