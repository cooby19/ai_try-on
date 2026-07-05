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

// 額度訊息文案：前置檢查（checkGenerationQuota）與插入後複驗（verifyJobWithinQuota）
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

// 建立 try_on_jobs 紀錄（同時就是額度的 +1）
export async function recordTryOnJob(input: {
  userId: string;
  productId: string;
  personImagePath: string;
  garmentImageUrl: string;
  provider: string;
  costEstimate: number;
  retryCount: number;
}): Promise<TryOnJob> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("try_on_jobs")
    .insert({
      user_id: input.userId,
      product_id: input.productId,
      person_image_url: input.personImagePath,
      garment_image_url: input.garmentImageUrl,
      provider: input.provider,
      status: "pending",
      cost_estimate: input.costEstimate,
      retry_count: input.retryCount,
    })
    .select()
    .single();
  if (error) throw new Error(`建立試穿任務失敗：${error.message}`);
  return data as TryOnJob;
}

export interface QuotaVerification {
  allowed: boolean;
  reason?: string;
  remainingToday: number; // 本次任務判定後的當日剩餘次數（勝出時已把自己算進去）
}

// 插入後複驗（防併發額度競態）：
// checkGenerationQuota（SELECT 計數）與 recordTryOnJob（INSERT）非原子，
// 並發請求可能同時通過前置檢查再各自插入，超額 job 會一路執行到
// provider.submit() 產生真實 API 成本。這裡在「已插入、尚未呼叫 AI API」的
// 時間點重查當日全部 job，以 (created_at, id) 排序取得確定性名次：
// 名次超限者即競態落敗，刪列並拒絕——錢在花掉之前就被擋下。
// INSERT 經 Supabase REST 已各自提交，並發雙方重查時看到相同資料、
// 算出相同勝負（恰好由較早插入者勝出），當日實際送出 provider 的
// 任務數因此嚴格不超過上限。
export async function verifyJobWithinQuota(input: {
  jobId: string;
  userId: string;
  productId: string;
  retryCount: number; // 插入時寫入的 retry_count（= 前置檢查的 productAttemptsToday）
}): Promise<QuotaVerification> {
  const supabase = getSupabaseAdmin();
  const since = todayStartUtcIso();

  const { data, error } = await supabase
    .from("try_on_jobs")
    .select("id, product_id, created_at")
    .eq("user_id", input.userId)
    .gte("created_at", since);
  if (error) throw new Error(`額度驗證失敗：${error.message}`);

  // created_at 可能同毫秒，補 id 作 tie-break：並發雙方各自排序的結果
  // 必須完全一致，勝負判定才不會兩邊都自認贏家（或兩敗俱傷）。
  const rows = [...data].sort((a, b) => {
    const diff = new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const dailyRank = rows.findIndex((r) => r.id === input.jobId);
  const productRank = rows
    .filter((r) => r.product_id === input.productId)
    .findIndex((r) => r.id === input.jobId);

  // 重查理應包含自己剛插入的列；找不到代表計數已不可信，
  // 依「寧可多扣、不可少扣」原則視為落敗（fail-closed），不冒多花錢的風險。
  const overDaily = dailyRank === -1 || dailyRank >= DAILY_GENERATION_LIMIT;
  const overProduct = productRank === -1 || productRank >= 1 + PER_PRODUCT_RETRY_LIMIT;

  if (overDaily || overProduct) {
    // 刪除競態落敗列。CLAUDE.md「刪除時保留 job 列」防的是「生成後刪列刷額度」
    // ——那些 job 已呼叫 AI API、產生成本；這筆從未到達 submit、零成本，
    // 留著反而讓使用者被拒絕（429）還白扣一格額度，因此是刻意授權的例外。
    // 刪除失敗也不擋路（不檢查 error）：列留著只是多占一格額度（多扣安全），
    // 不會多花錢（少扣才危險）。
    await supabase.from("try_on_jobs").delete().eq("id", input.jobId);
    return {
      allowed: false,
      reason: overDaily ? dailyLimitReason() : productLimitReason(),
      remainingToday: Math.max(0, DAILY_GENERATION_LIMIT - (rows.length - 1)),
    };
  }

  if (productRank !== input.retryCount) {
    // 並發下兩筆可能在前置檢查拿到相同的 productAttemptsToday，
    // 以複驗名次修正 retry_count。此欄位僅供成本統計，
    // 更新失敗不阻斷主流程（不影響額度計算與金額）。
    await supabase
      .from("try_on_jobs")
      .update({ retry_count: productRank, updated_at: new Date().toISOString() })
      .eq("id", input.jobId);
  }

  return {
    allowed: true,
    remainingToday: Math.max(0, DAILY_GENERATION_LIMIT - rows.length),
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
