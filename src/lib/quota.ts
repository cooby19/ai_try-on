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
      reason: `你今天的 AI 試穿額度（${DAILY_GENERATION_LIMIT} 次）已用完，明天會自動恢復。`,
      usedToday, remainingToday, productAttemptsToday, remainingRetriesForProduct,
    };
  }
  if (productAttemptsToday >= 1 + PER_PRODUCT_RETRY_LIMIT) {
    return {
      allowed: false,
      reason: `這件商品今天已重新生成 ${PER_PRODUCT_RETRY_LIMIT} 次，達到上限。可以先試試其他商品，或明天再試。`,
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
