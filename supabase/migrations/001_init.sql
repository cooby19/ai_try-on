-- AI 虛擬試衣 MVP 資料庫初始化
-- 使用方式：貼到 Supabase Dashboard 的 SQL Editor 執行一次即可。

create extension if not exists "pgcrypto";

-- ============================================================
-- users：使用者（MVP 用匿名 cookie ID，email 保留給未來登入功能）
-- ============================================================
create table if not exists public.users (
  id uuid primary key,
  email text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- products：商品（第一版只有上衣 category = 'tops'）
-- ============================================================
create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  price numeric(10, 2) not null,
  image_url text not null,          -- 商品展示圖
  garment_image_url text not null,  -- 給 VTO API 用的上衣圖（平放/去背）
  category text not null default 'tops',
  color text,
  fit text,
  material text,
  size_chart jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- try_on_jobs：每一次 AI 試穿任務（含狀態、成本、重試、錯誤）
-- ============================================================
create table if not exists public.try_on_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users (id),
  product_id uuid not null references public.products (id),
  person_image_url text not null,   -- Supabase Storage 內的路徑（非公開 URL）
  garment_image_url text not null,
  result_image_url text,            -- Supabase Storage 內的路徑（非公開 URL）
  provider text not null,
  -- provider_job_id：規格書外的必要欄位——第三方 API 採「送出後輪詢」模式，
  -- 需要記住對方的任務 ID 才能查詢進度
  provider_job_id text,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'success', 'failed')),
  cost_estimate numeric(10, 4) not null default 0,
  retry_count int not null default 0, -- 此使用者對此商品的第幾次重試（0 = 首次生成）
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists try_on_jobs_user_created_idx
  on public.try_on_jobs (user_id, created_at);
create index if not exists try_on_jobs_user_product_idx
  on public.try_on_jobs (user_id, product_id, created_at);

-- ============================================================
-- try_on_feedback：使用者對生成結果的回饋
-- ============================================================
create table if not exists public.try_on_feedback (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.try_on_jobs (id) on delete cascade,
  user_id uuid not null,
  product_id uuid not null,
  rating text not null check (rating in ('satisfied', 'unsatisfied')),
  feedback_text text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- RLS：全部開啟且不建立任何 public policy。
-- 所有存取都經由後端 API（service role key，會繞過 RLS），
-- 因此即使 anon key 外洩，也讀不到任何資料。
-- ============================================================
alter table public.users enable row level security;
alter table public.products enable row level security;
alter table public.try_on_jobs enable row level security;
alter table public.try_on_feedback enable row level security;

-- ============================================================
-- 權限：後端一律用 service role 存取。
-- 新版 Supabase 專案（sb_secret_ 金鑰）在 SQL Editor 建表後
-- 不會自動授權給 service_role，需明確 GRANT。
-- ============================================================
grant usage on schema public to service_role;
grant all privileges on all tables in schema public to service_role;
alter default privileges in schema public grant all privileges on tables to service_role;

-- ============================================================
-- Storage buckets：人物照與結果圖都放「私有」bucket，
-- 前端只透過後端簽發的短期 signed URL 存取（隱私需求）。
-- ============================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'person-uploads', 'person-uploads', false, 8388608,
  array['image/jpeg', 'image/png', 'image/webp']::text[]
)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('try-on-results', 'try-on-results', false)
on conflict (id) do nothing;

-- ============================================================
-- 種子商品：三件上衣（圖片放在專案的 public/garments/）
-- ============================================================
insert into public.products
  (id, name, price, image_url, garment_image_url, category, color, fit, material, size_chart)
values
  (
    '00000000-0000-0000-0000-000000000001',
    '經典白色圓領 T 恤', 590,
    '/garments/white-tee.svg', '/garments/white-tee.svg',
    'tops', '白色', '合身', '100% 純棉',
    '{"S": "胸圍 88cm / 衣長 66cm", "M": "胸圍 94cm / 衣長 69cm", "L": "胸圍 100cm / 衣長 72cm"}'
  ),
  (
    '00000000-0000-0000-0000-000000000002',
    '深藍寬鬆圓領 T 恤', 690,
    '/garments/navy-tee.svg', '/garments/navy-tee.svg',
    'tops', '深藍', '寬鬆', '棉 95% / 彈性纖維 5%',
    '{"S": "胸圍 96cm / 衣長 68cm", "M": "胸圍 102cm / 衣長 71cm", "L": "胸圍 108cm / 衣長 74cm"}'
  ),
  (
    '00000000-0000-0000-0000-000000000003',
    '橄欖綠休閒 T 恤', 650,
    '/garments/olive-tee.svg', '/garments/olive-tee.svg',
    'tops', '橄欖綠', '標準', '棉 80% / 聚酯纖維 20%',
    '{"S": "胸圍 90cm / 衣長 67cm", "M": "胸圍 96cm / 衣長 70cm", "L": "胸圍 102cm / 衣長 73cm"}'
  )
on conflict (id) do nothing;
