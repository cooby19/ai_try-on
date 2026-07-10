-- 002：原子化的「額度檢查＋插入 try_on_jobs」（取代應用層的插入後複驗）
-- 使用方式：貼到 Supabase Dashboard 的 SQL Editor 執行一次即可（001 之後）。
--
-- 為什麼需要這個函式：
-- 應用層的「SELECT 計數 → INSERT → 複驗名次」不是原子操作。舊的複驗機制
-- （verifyJobWithinQuota）以 created_at 排名判定並發勝負，但 created_at 是
-- 交易「開始」時間、資料可見性卻跟隨「commit」順序，兩者倒置時並發雙方
-- 可各自算出自己在限內、雙雙放行而超額。把計數與插入放進同一個 DB 函式、
-- 用 advisory lock 序列化，才能真正保證「當日筆數嚴格不超過上限」。
--
-- 正確性依賴兩件事，修改時不可破壞：
--   1. pg_advisory_xact_lock：同一使用者＋同一天（p_since）只有一個交易能
--      進入計數＋插入區段，鎖在交易 commit 時自動釋放。
--   2. READ COMMITTED（Supabase 預設隔離等級）下，函式內每個語句都拿新的
--      snapshot：等鎖的交易在取得鎖之後計數，必然看得到前一個交易剛 commit
--      的插入。若改成 REPEATABLE READ，snapshot 固定在交易開頭，防護即失效。
create or replace function public.insert_try_on_job_within_quota(
  p_user_id uuid,
  p_product_id uuid,
  p_person_image_url text,
  p_garment_image_url text,
  p_provider text,
  p_cost_estimate numeric,
  -- 「今天」的起點（台北時區 UTC+8 換算成的 UTC 時刻）。由應用層的
  -- todayStartUtcIso() 傳入，讓時區規則維持單一出處（src/lib/quota.ts）。
  p_since timestamptz,
  -- 額度上限同樣由應用層傳入（常數的單一出處是 src/lib/quota.ts）。
  -- p_product_attempt_limit = 首次 + 重試上限（目前為 1 + 2 = 3）。
  p_daily_limit int,
  p_product_attempt_limit int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_used_today int;
  v_product_attempts int;
  v_job public.try_on_jobs;
begin
  -- 序列化「同一使用者、同一天」的插入；不同使用者互不阻塞。
  -- 以 p_since 當日期鍵（同一天內每次呼叫的值相同），hashtext 把字串壓成
  -- advisory lock 需要的 bigint key。
  perform pg_advisory_xact_lock(hashtext(p_user_id::text || p_since::text));

  select count(*) into v_used_today
  from public.try_on_jobs
  where user_id = p_user_id and created_at >= p_since;

  select count(*) into v_product_attempts
  from public.try_on_jobs
  where user_id = p_user_id and product_id = p_product_id and created_at >= p_since;

  -- 超限：不插入、直接回拒絕標記。每日 / 每商品分開回報，
  -- 應用層據此挑對應的繁中文案（文案不放 DB，跟著程式碼走）。
  if v_used_today >= p_daily_limit then
    return jsonb_build_object(
      'allowed', false,
      'reject_reason', 'daily',
      'used_today', v_used_today,
      'product_attempts_today', v_product_attempts
    );
  end if;
  if v_product_attempts >= p_product_attempt_limit then
    return jsonb_build_object(
      'allowed', false,
      'reject_reason', 'product',
      'used_today', v_used_today,
      'product_attempts_today', v_product_attempts
    );
  end if;

  -- 在限內：插入即「額度 +1」（額度 = 當日筆數的設計不變）。
  -- retry_count 直接用鎖內算出的名次，天生正確，不再需要事後修正。
  insert into public.try_on_jobs
    (user_id, product_id, person_image_url, garment_image_url,
     provider, status, cost_estimate, retry_count)
  values
    (p_user_id, p_product_id, p_person_image_url, p_garment_image_url,
     p_provider, 'pending', p_cost_estimate, v_product_attempts)
  returning * into v_job;

  return jsonb_build_object(
    'allowed', true,
    'used_today', v_used_today + 1,
    'product_attempts_today', v_product_attempts,
    'job', to_jsonb(v_job)
  );
end;
$$;

-- 權限：SECURITY DEFINER 函式預設對 PUBLIC 開放 EXECUTE，等於讓 anon key
-- 繞過 RLS 直接寫 try_on_jobs——必須收回，只留 service_role（後端專用）。
-- 新版 Supabase 專案（sb_secret_ 金鑰）不會自動授權，需明確 GRANT（同 001 尾段）。
revoke execute on function public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, timestamptz, int, int
) from public, anon, authenticated;
grant execute on function public.insert_try_on_job_within_quota(
  uuid, uuid, text, text, text, numeric, timestamptz, int, int
) to service_role;
