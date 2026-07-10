// 成本控管（規格書第七節）：
//   1. 每位使用者每日最多生成 3 次
//   2. 每個商品每位使用者最多重試 2 次（首次 + 2 次重試 = 同商品最多 3 次）
//   3. 每次呼叫 AI API 前都必須先通過這裡的檢查
//
// 設計說明：額度不是存一個計數器欄位，而是直接統計 try_on_jobs 的當日筆數。
// 這樣「建立 job 紀錄」本身就是 incrementGenerationUsage，不會有計數器與紀錄不同步的問題。
// 失敗的生成也計入額度（因為已經呼叫過 AI API、產生了成本）。
import { getSupabaseAdmin, PERSON_BUCKET } from "./supabase";
import { ensureUserRow } from "./user";
import type { JobStatus, TryOnJob } from "./types";

// Postgres 外鍵違反的錯誤碼（try_on_jobs.user_id → users.id 缺列時觸發）
const FK_VIOLATION_CODE = "23503";

export const DAILY_GENERATION_LIMIT = 3;
export const PER_PRODUCT_RETRY_LIMIT = 2;
// 每日照片上傳上限：生成額度只管 try_on_jobs，上傳本身不建 job，
// 若不設限就是額度機制外的成本破口（sharp CPU + 私有 bucket 無限累積，
// 且目前沒有自動清理）。取 3 次生成 × 換照片重試的合理餘裕。
export const DAILY_UPLOAD_LIMIT = 10;

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

// 上傳額度訊息：與生成額度同一套「告訴使用者下一步」的文案慣例。
function uploadLimitReason(): string {
  return `你今天的照片上傳次數（${DAILY_UPLOAD_LIMIT} 次）已用完，明天會自動恢復。已上傳的照片仍可用於試穿。`;
}

export interface UploadQuotaCheck {
  allowed: boolean;
  reason?: string;
  usedToday: number;
}

// 上傳額度＝統計 person-uploads 私有 bucket 內該使用者資料夾的「當日」檔案數，
// 不另建資料表（與生成額度「不設計數器欄位」同一哲學：以既有事實為準）。
// 刻意不用原子鎖：migration 002 那套是防「花 AI API 錢」的併發競態，
// 上傳單次成本低，計數有小誤差可接受，輕量防護即可。
// 注意：list 只取「最新 DAILY_UPLOAD_LIMIT 筆」——判定只需要知道當日筆數
// 是否達上限：若最新 N 筆全是今天的，代表已達上限；否則過濾後就是精確筆數，
// 不必翻整個資料夾（使用者累積的舊照片可能很多）。
export async function checkUploadQuota(userId: string): Promise<UploadQuotaCheck> {
  const supabase = getSupabaseAdmin();
  const sinceMs = Date.parse(todayStartUtcIso());

  const { data, error } = await supabase.storage.from(PERSON_BUCKET).list(userId, {
    limit: DAILY_UPLOAD_LIMIT,
    sortBy: { column: "created_at", order: "desc" },
  });
  // fail-closed：查詢失敗不能默默當成 0 筆放行（與生成額度查詢失敗同一原則）
  if (error) throw new Error(`上傳額度查詢失敗：${error.message}`);

  // Supabase Storage 的型別允許 created_at 為 null；缺少時間的檔案無法判定為今日上傳，
  // 不納入今日計數。正常由 upload() 建立的物件都會帶 created_at。
  const usedToday = (data ?? []).filter(
    (f) => typeof f.created_at === "string" && Date.parse(f.created_at) >= sinceMs
  ).length;
  if (usedToday >= DAILY_UPLOAD_LIMIT) {
    return { allowed: false, reason: uploadLimitReason(), usedToday };
  }
  return { allowed: true, usedToday };
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
  const rpcArgs = {
    p_user_id: input.userId,
    p_product_id: input.productId,
    p_person_image_url: input.personImagePath,
    p_garment_image_url: input.garmentImageUrl,
    p_provider: input.provider,
    p_cost_estimate: input.costEstimate,
    p_since: todayStartUtcIso(),
    p_daily_limit: DAILY_GENERATION_LIMIT,
    p_product_attempt_limit: 1 + PER_PRODUCT_RETRY_LIMIT,
  };
  let { data, error } = await supabase.rpc("insert_try_on_job_within_quota", rpcArgs);

  // 自癒路徑：踩到外鍵錯誤，代表 users 列缺失（首次來訪時補列剛好瞬斷、
  // 或資料庫重建但使用者帶著一年效期的舊 cookie 回來）。cookie 既有效，
  // getOrCreateUserId 不會再補列，不在這裡自癒的話，這位使用者之後每次
  // 試穿都會失敗、直到自己清 cookie。補一次 users 列後重試一次插入即可脫困；
  // 只重試一次，避免真正的資料異常（如 product_id 外鍵失效）變成無限重試。
  // 額度不受影響：第一次插入根本沒成功，本來就沒扣。
  if (error?.code === FK_VIOLATION_CODE) {
    await ensureUserRow(input.userId);
    ({ data, error } = await supabase.rpc("insert_try_on_job_within_quota", rpcArgs));
  }
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
