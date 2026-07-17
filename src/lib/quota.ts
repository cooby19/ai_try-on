// 成本控管（規格書第七節）：
//   1. 每位使用者每日最多生成 3 次
//   2. 每個商品每位使用者最多重試 2 次（首次 + 2 次重試 = 同商品最多 3 次）
//   3. 平台每日預算到頂後全部熔斷
//   4. 每次呼叫 AI API 前都必須先通過這裡的檢查
//
// 設計說明：額度不是存一個計數器欄位，而是直接統計 try_on_jobs 的當日筆數。
// 這樣「建立 job 紀錄」本身就是 incrementGenerationUsage，不會有計數器與紀錄不同步的問題。
// 失敗的生成也計入額度（因為已經呼叫過 AI API、產生了成本）。
import { getSupabaseAdmin, PERSON_BUCKET } from "./supabase";
import type {
  JobStatus,
  TryOnConfigSnapshotV1,
  TryOnErrorType,
  TryOnJob,
} from "./types";

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

function platformBudgetReason(): string {
  return "今日 AI 試穿服務已達平台安全預算，請明天再試。";
}

export function platformDailyBudgetUsd(): number {
  const value = Number(process.env.PLATFORM_DAILY_BUDGET_USD ?? "5");
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("PLATFORM_DAILY_BUDGET_USD 必須是大於 0 的數字；為避免成本失控，本次生成已停止。");
  }
  return value;
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

// 上傳額度＝統計 person-uploads 私有 bucket 內該使用者資料夾的「當日正式 JPEG」數，
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
    // 直傳流程的 .upload 臨時檔不算完成上傳，也不能擠掉列表中的正式照片。
    search: ".jpg",
    sortBy: { column: "created_at", order: "desc" },
  });
  // fail-closed：查詢失敗不能默默當成 0 筆放行（與生成額度查詢失敗同一原則）
  if (error) throw new Error(`上傳額度查詢失敗：${error.message}`);

  // Supabase Storage 的型別允許 created_at 為 null；缺少時間的檔案無法判定為今日上傳，
  // 不納入今日計數。正常由 upload() 建立的物件都會帶 created_at。
  const usedToday = (data ?? []).filter(
    (f) => f.name.endsWith(".jpg") && typeof f.created_at === "string" && Date.parse(f.created_at) >= sinceMs
  ).length;
  if (usedToday >= DAILY_UPLOAD_LIMIT) {
    return { allowed: false, reason: uploadLimitReason(), usedToday };
  }
  return { allowed: true, usedToday };
}

export async function checkGenerationQuota(
  userId: string,
  productId: string
): Promise<QuotaCheck> {
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

export type AtomicJobCreationResult =
  | { outcome: "created" | "replayed"; remainingToday: number; job: TryOnJob }
  | { outcome: "conflict"; remainingToday: number; job: TryOnJob }
  | { outcome: "rejected"; remainingToday: number; reason: string };

// insert_try_on_job_within_quota（migration 005）回傳的 jsonb 形狀。
interface AtomicInsertResult {
  outcome: "created" | "replayed" | "conflict" | "rejected";
  reject_reason?: "daily" | "product" | "platform";
  used_today: number;
  product_attempts_today: number;
  job?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseTryOnJob(value: unknown): TryOnJob | null {
  if (!isRecord(value)) return null;
  const configSnapshot = value.config_snapshot;
  const snapshotGeneration = isRecord(configSnapshot) ? configSnapshot.generation : null;
  if (
    typeof value.id !== "string" ||
    typeof value.user_id !== "string" ||
    typeof value.product_id !== "string" ||
    typeof value.garment_image_url !== "string" ||
    typeof value.provider !== "string" ||
    !["pending", "processing", "success", "failed"].includes(String(value.status)) ||
    typeof value.retry_count !== "number" ||
    typeof value.seed !== "number" ||
    !Number.isInteger(value.seed) ||
    value.seed < 0 ||
    value.seed > 4294967295 ||
    !isRecord(configSnapshot) ||
    configSnapshot.schemaVersion !== 1 ||
    !isRecord(snapshotGeneration) ||
    snapshotGeneration.seed !== value.seed ||
    typeof value.started_at !== "string" ||
    !(
      (value.idempotency_key === null && value.request_fingerprint === null) ||
      (typeof value.idempotency_key === "string" &&
        typeof value.request_fingerprint === "string" &&
        /^[0-9a-f]{64}$/.test(value.request_fingerprint))
    ) ||
    typeof value.created_at !== "string" ||
    typeof value.updated_at !== "string"
  ) {
    return null;
  }
  return value as unknown as TryOnJob;
}

function parseAtomicInsertResult(value: unknown): AtomicInsertResult | null {
  if (!isRecord(value)) return null;
  if (
    !["created", "replayed", "conflict", "rejected"].includes(String(value.outcome)) ||
    typeof value.used_today !== "number" ||
    !Number.isInteger(value.used_today) ||
    value.used_today < 0 ||
    typeof value.product_attempts_today !== "number" ||
    !Number.isInteger(value.product_attempts_today) ||
    value.product_attempts_today < 0
  ) {
    return null;
  }
  if (
    value.reject_reason !== undefined &&
    !["daily", "product", "platform"].includes(String(value.reject_reason))
  ) {
    return null;
  }
  return {
    outcome: value.outcome as AtomicInsertResult["outcome"],
    reject_reason: value.reject_reason as AtomicInsertResult["reject_reason"],
    used_today: value.used_today,
    product_attempts_today: value.product_attempts_today,
    job: value.job,
  };
}

// 建立 try_on_jobs 紀錄（同時就是額度的 +1），額度檢查與插入在 DB 端原子完成。
//
// 為什麼走 RPC 而不是在應用層「SELECT 計數 → INSERT → 複驗」：
// 那三步不是原子操作。舊的複驗機制以 (created_at, id) 排名判定並發勝負，
// 但 created_at 是交易「開始」時間、資料可見性卻跟隨「commit」順序，
// 兩者倒置時（先開始者較晚 commit）並發雙方可各自算出自己在限內、
// 雙雙放行而超額。migration 005 的 Postgres 函式用 pg_advisory_xact_lock
// 序列化「平台＋Auth 使用者＋同一天」的檢查與插入，才能保證成本嚴格不超過上限。
// 時區邊界（p_since）與額度常數仍由本模組傳入，維持單一出處。
export async function recordTryOnJob(input: {
  userId: string;
  productId: string;
  personImagePath: string;
  garmentImageUrl: string;
  provider: string;
  costEstimate: number;
  budgetReservation: number;
  seed: number;
  configSnapshot: TryOnConfigSnapshotV1;
  startedAt: string;
  idempotencyKey?: string;
  requestFingerprint?: string;
}): Promise<AtomicJobCreationResult> {
  const supabase = getSupabaseAdmin();
  const rpcArgs = {
    p_user_id: input.userId,
    p_product_id: input.productId,
    p_person_image_url: input.personImagePath,
    p_garment_image_url: input.garmentImageUrl,
    p_provider: input.provider,
    p_cost_estimate: input.costEstimate,
    p_budget_reservation: input.budgetReservation,
    p_since: todayStartUtcIso(),
    p_daily_limit: DAILY_GENERATION_LIMIT,
    p_product_attempt_limit: 1 + PER_PRODUCT_RETRY_LIMIT,
    p_platform_daily_budget: platformDailyBudgetUsd(),
    p_seed: input.seed,
    p_config_snapshot: input.configSnapshot,
    p_started_at: input.startedAt,
    p_idempotency_key: input.idempotencyKey ?? null,
    p_request_fingerprint: input.requestFingerprint ?? null,
  };
  const { data, error } = await supabase.rpc("insert_try_on_job_within_quota", rpcArgs);
  if (error) throw new Error(`建立試穿任務失敗：${error.message}`);

  // 回傳形狀不符（如 migration 004 尚未執行、或函式被改壞）一律 throw，
  // 不能默默當成功或當額度充足放行（fail-closed，與額度查詢失敗同一原則）。
  const result = parseAtomicInsertResult(data);
  if (!result) {
    throw new Error("建立試穿任務失敗：額度函式回傳格式異常（請確認最新 migration 已執行）。");
  }

  if (result.outcome === "rejected") {
    // 拒絕文案由程式端對應（daily / product / platform），
    // 使用者在兩條路徑看到一字不差的訊息。
    return {
      outcome: "rejected",
      reason:
        result.reject_reason === "product"
          ? productLimitReason()
          : result.reject_reason === "platform"
            ? platformBudgetReason()
            : dailyLimitReason(),
      remainingToday: Math.max(0, DAILY_GENERATION_LIMIT - result.used_today),
    };
  }
  const job = parseTryOnJob(result.job);
  if (!job) {
    throw new Error("建立試穿任務失敗：額度函式未回傳任務資料。");
  }
  const expectedKey = input.idempotencyKey ?? null;
  const expectedFingerprint = input.requestFingerprint ?? null;
  const idempotencyIdentityMatches =
    job.idempotency_key === expectedKey &&
    (result.outcome === "conflict"
      ? job.request_fingerprint !== expectedFingerprint
      : job.request_fingerprint === expectedFingerprint);
  if (!idempotencyIdentityMatches) {
    throw new Error("建立試穿任務失敗：額度函式回傳的冪等身分不相符。");
  }
  return {
    outcome: result.outcome,
    job,
    remainingToday: Math.max(0, DAILY_GENERATION_LIMIT - result.used_today),
  };
}

export async function findTryOnJobByIdempotency(
  userId: string,
  idempotencyKey: string,
): Promise<TryOnJob | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("try_on_jobs")
    .select("*")
    .eq("user_id", userId)
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`查詢冪等任務失敗：${error.message}`);
  if (data === null) return null;
  const job = parseTryOnJob(data);
  if (!job) throw new Error("查詢冪等任務失敗：資料格式異常。");
  return job;
}

export async function updateJobStatus(
  jobId: string,
  fields: Partial<{
    status: JobStatus;
    provider_job_id: string;
    result_image_url: string;
    error_message: string | null;
    error_type: TryOnErrorType | null;
    error_code: string | null;
    provider_http_status: number | null;
    last_polled_at: string;
  }>,
  eventAt = new Date().toISOString(),
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const lifecycleFields: Record<string, unknown> = {};
  if (fields.status === "processing" && fields.provider_job_id) {
    lifecycleFields.provider_submitted_at = eventAt;
  }
  if (fields.status === "success" || fields.status === "failed") {
    lifecycleFields.completed_at = eventAt;
  }
  if (fields.status === "success") {
    lifecycleFields.error_message = null;
    lifecycleFields.error_type = null;
    lifecycleFields.error_code = null;
    lifecycleFields.provider_http_status = null;
  }

  let query = supabase
    .from("try_on_jobs")
    .update({ ...fields, ...lifecycleFields, updated_at: eventAt })
    .eq("id", jobId);
  // 只有非終態可轉成 processing/success/failed；併發重複輪詢不會覆寫首次 completed_at。
  if (fields.status) query = query.in("status", ["pending", "processing"]);
  const { error } = await query;
  if (error) throw new Error(`更新任務狀態失敗：${error.message}`);
}
