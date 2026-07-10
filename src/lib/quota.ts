// 成本控管（規格書第七節）：
//   1. 每位使用者每日最多生成 3 次
//   2. 每個商品每位使用者最多重試 2 次（首次 + 2 次重試 = 同商品最多 3 次）
//   3. 每次呼叫 AI API 前都必須先通過這裡的檢查
//
// 設計說明：額度不是存一個計數器欄位，而是直接統計 try_on_jobs 的當日筆數。
// 這樣「建立 job 紀錄」本身就是 incrementGenerationUsage，不會有計數器與紀錄不同步的問題。
// 失敗的生成也計入額度（因為已經呼叫過 AI API、產生了成本）。
import { getSupabaseAdmin } from "./supabase";
import type { JobStatus, TryOnJob } from "./types";

export const DAILY_GENERATION_LIMIT = 3;
export const PER_PRODUCT_RETRY_LIMIT = 2;

// 「每日」以台北時區（UTC+8）為界。
// export 是為了讓單元測試能直接驗證時區邊界（行為不變，仍僅供本模組與測試使用）。
export function todayStartUtcIso(): string {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  taipeiNow.setUTCHours(0, 0, 0, 0);
  return new Date(taipeiNow.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

export interface QuotaCheck {
  allowed: boolean;
  reason?: string;
  usedToday: number;
  remainingToday: number;
  productAttemptsToday: number; // 今天對這個商品已生成幾次（= 新 job 的 retry_count）
  remainingRetriesForProduct: number;
}

// 額度訊息文案：前置檢查（checkGenerationQuota）與原子插入（recordTryOnJob）
// 都會把這些文案回給使用者，抽成共用函式避免兩處各寫一份逐漸漂移
// （單元測試釘住文案內容，漂移會直接紅）。
function dailyLimitReason(): string {
  return `你今天的 AI 試穿額度（${DAILY_GENERATION_LIMIT} 次）已用完，明天會自動恢復。`;
}

function productLimitReason(): string {
  return `這件商品今天已重新生成 ${PER_PRODUCT_RETRY_LIMIT} 次，達到上限。可以先試試其他商品，或明天再試。`;
}

export async function checkGenerationQuota(userId: string, productId: string): Promise<QuotaCheck> {
  const supabase = getSupabaseAdmin();
  const since = todayStartUtcIso();

  const { data, error } = await supabase
    .from("try_on_jobs")
    .select("id, product_id")
    .eq("user_id", userId)
    .gte("created_at", since);
  if (error) throw new Error(`額度查詢失敗：${error.message}`);

  const usedToday = data.length;
  const productAttemptsToday = data.filter((j) => j.product_id === productId).length;
  const remainingToday = Math.max(0, DAILY_GENERATION_LIMIT - usedToday);
  const remainingRetriesForProduct = Math.max(0, 1 + PER_PRODUCT_RETRY_LIMIT - productAttemptsToday);

  if (usedToday >= DAILY_GENERATION_LIMIT) {
    return {
      allowed: false,
      reason: dailyLimitReason(),
      usedToday, remainingToday, productAttemptsToday, remainingRetriesForProduct,
    };
  }
  if (productAttemptsToday >= 1 + PER_PRODUCT_RETRY_LIMIT) {
    return {
      allowed: false,
      reason: productLimitReason(),
      usedToday, remainingToday, productAttemptsToday, remainingRetriesForProduct,
    };
  }
  return { allowed: true, usedToday, remainingToday, productAttemptsToday, remainingRetriesForProduct };
}

export interface TryOnJobCreation {
  allowed: boolean;
  reason?: string;
  remainingToday: number; // 判定後的當日剩餘次數（成功時已把自己算進去）
  job?: TryOnJob; // allowed = true 時必有值
}

// insert_try_on_job_within_quota（migration 002）回傳的 jsonb 形狀。
interface AtomicInsertResult {
  allowed: boolean;
  reject_reason?: "daily" | "product";
  used_today: number;
  product_attempts_today: number;
  job?: TryOnJob;
}

// 建立 try_on_jobs 紀錄（同時就是額度的 +1），額度檢查與插入在 DB 端原子完成。
//
// 為什麼走 RPC 而不是在應用層「SELECT 計數 → INSERT → 複驗」：
// 那三步不是原子操作。舊的複驗機制以 (created_at, id) 排名判定並發勝負，
// 但 created_at 是交易「開始」時間、資料可見性卻跟隨「commit」順序，
// 兩者倒置時（先開始者較晚 commit）並發雙方可各自算出自己在限內、
// 雙雙放行而超額。migration 002 的 Postgres 函式用 pg_advisory_xact_lock
// 序列化「同一使用者＋同一天」的計數＋插入，才能保證當日筆數嚴格不超過上限。
// 時區邊界（p_since）與額度常數仍由本模組傳入，維持單一出處。
export async function recordTryOnJob(input: {
  userId: string;
  productId: string;
  personImagePath: string;
  garmentImageUrl: string;
  provider: string;
  costEstimate: number;
}): Promise<TryOnJobCreation> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("insert_try_on_job_within_quota", {
    p_user_id: input.userId,
    p_product_id: input.productId,
    p_person_image_url: input.personImagePath,
    p_garment_image_url: input.garmentImageUrl,
    p_provider: input.provider,
    p_cost_estimate: input.costEstimate,
    p_since: todayStartUtcIso(),
    p_daily_limit: DAILY_GENERATION_LIMIT,
    p_product_attempt_limit: 1 + PER_PRODUCT_RETRY_LIMIT,
  });
  if (error) throw new Error(`建立試穿任務失敗：${error.message}`);

  // 回傳形狀不符（如 migration 002 尚未執行、或函式被改壞）一律 throw，
  // 不能默默當成功或當額度充足放行（fail-closed，與額度查詢失敗同一原則）。
  const result = data as AtomicInsertResult | null;
  if (!result || typeof result.allowed !== "boolean") {
    throw new Error("建立試穿任務失敗：額度函式回傳格式異常（請確認 migration 002 已執行）。");
  }

  if (!result.allowed) {
    // 拒絕文案由程式端對應（daily / product），與前置檢查共用同一組函式，
    // 使用者在兩條路徑看到一字不差的訊息。
    return {
      allowed: false,
      reason: result.reject_reason === "product" ? productLimitReason() : dailyLimitReason(),
      remainingToday: Math.max(0, DAILY_GENERATION_LIMIT - result.used_today),
    };
  }
  if (!result.job) {
    throw new Error("建立試穿任務失敗：額度函式未回傳任務資料。");
  }
  return {
    allowed: true,
    job: result.job,
    remainingToday: Math.max(0, DAILY_GENERATION_LIMIT - result.used_today),
  };
}

export async function updateJobStatus(
  jobId: string,
  fields: Partial<{
    status: JobStatus;
    provider_job_id: string;
    result_image_url: string;
    error_message: string;
  }>
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("try_on_jobs")
    .update({ ...fields, updated_at: new Date().toISOString() })
    .eq("id", jobId);
  if (error) throw new Error(`更新任務狀態失敗：${error.message}`);
}
