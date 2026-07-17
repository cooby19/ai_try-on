import "server-only";

import { enhanceResultImage, getEnhancementCostEstimate } from "../enhance";
import { loadImageAsPngBuffer } from "../images";
import {
  checkGenerationQuota,
  findTryOnJobByIdempotency,
  recordTryOnJob,
  updateJobStatus,
} from "../quota";
import {
  createSignedUrl,
  getSupabaseAdmin,
  PERSON_BUCKET,
  RESULT_BUCKET,
} from "../supabase";
import type { Product, TryOnErrorType, TryOnJob, TryOnJobView } from "../types";
import { isOwnedPersonImagePath } from "../upload-intent";
import { toJpegUploadBlob } from "../validation";
import { getVTOProvider, resolveVTOProviderName } from "../vto";
import {
  VTOProviderError,
  type VTOImageInput,
  type VTOStatusResult,
} from "../vto/provider";
import {
  isValidGenerationSeed,
  resolveGenerationSeed,
  resolveTryOnConfig,
} from "./config";
import {
  IDEMPOTENCY_CONFLICT_MESSAGE,
  IDEMPOTENCY_KEY_ERROR_MESSAGE,
  createIdempotentGenerationSeed,
  createTryOnRequestFingerprint,
  isValidIdempotencyKey,
} from "./idempotency";

export interface StartTryOnInput {
  userId: string;
  productId?: string;
  personImagePath?: string;
  requestedModel?: unknown;
  seed?: number;
  idempotencyKey?: string;
}

export type StartTryOnWorkflowResult =
  | {
      ok: true;
      jobId: string;
      status: "processing";
      costEstimate: number;
      remainingToday: number;
    }
  | { ok: false; code: "missing_input"; message: string }
  | { ok: false; code: "unsupported_model"; message: string }
  | { ok: false; code: "invalid_person_image"; message: string }
  | { ok: false; code: "invalid_seed"; message: string }
  | { ok: false; code: "invalid_idempotency_key"; message: string }
  | { ok: false; code: "idempotency_conflict"; message: string }
  | { ok: false; code: "product_not_found"; message: string }
  | {
      ok: false;
      code: "quota_rejected";
      message: string;
      remainingToday: number;
    }
  | {
      ok: false;
      code: "submission_failed";
      message: string;
      jobId: string;
    };

export interface GetAndAdvanceTryOnInput {
  userId: string;
  jobId: string;
}

export type GetAndAdvanceTryOnWorkflowResult =
  | { ok: true; view: TryOnJobView }
  | { ok: false; code: "job_not_found"; message: string }
  | { ok: false; code: "source_image_removed"; message: string };

function workflowErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "發生未知錯誤";
}

async function loadOwnedTryOnJob(jobId: string, userId: string): Promise<TryOnJob | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("try_on_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId)
    .single<TryOnJob>();
  return data ?? null;
}

type PollContextResult =
  | { ok: true; context?: VTOImageInput }
  | { ok: false; code: "source_image_removed"; message: string };

async function buildPollContext(
  job: TryOnJob,
  requiresImagesOnPoll: boolean
): Promise<PollContextResult> {
  if (!requiresImagesOnPoll) return { ok: true };
  if (!job.person_image_url) {
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: "人物照已依資料保留政策清除。",
      error_type: "person_image_read",
      error_code: "PERSON_IMAGE_REMOVED",
    });
    return {
      ok: false,
      code: "source_image_removed",
      message: "此試穿任務的原始照片已清除，無法繼續處理。",
    };
  }

  const supabase = getSupabaseAdmin();
  const { data: personFile } = await supabase.storage
    .from(PERSON_BUCKET)
    .download(job.person_image_url);
  if (!personFile) return { ok: true };

  return {
    ok: true,
    context: {
      personImage: Buffer.from(await personFile.arrayBuffer()),
      garmentImage: await loadImageAsPngBuffer(job.garment_image_url),
      garmentType: "tops",
    },
  };
}

async function finalizeSuccessfulJob(job: TryOnJob, resultImage: Buffer): Promise<TryOnJob> {
  // Enhance 自己負責失敗降級；這裡拿到的 image 無論是否放大都可繼續儲存。
  let enhanceOutcome;
  try {
    enhanceOutcome = await enhanceResultImage(resultImage, job.provider);
  } catch (cause) {
    // 正常 enhancer 會自行降級；走到這裡代表未預期的內部契約破壞。
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: workflowErrorMessage(cause),
      error_type: "internal",
      error_code: "INTERNAL_ERROR",
    });
    throw cause;
  }
  const resultPath = `${job.user_id}/${job.id}.jpg`;
  const supabase = getSupabaseAdmin();
  const uploadBody = toJpegUploadBlob(enhanceOutcome.image);
  let uploadError: { message: string } | null;
  try {
    const uploadResult = await supabase.storage
      .from(RESULT_BUCKET)
      .upload(resultPath, uploadBody, { contentType: "image/jpeg", upsert: true });
    uploadError = uploadResult.error;
  } catch (cause) {
    uploadError = { message: workflowErrorMessage(cause) };
  }

  if (uploadError) {
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: `結果圖儲存失敗：${uploadError.message}`,
      error_type: "result_storage",
      error_code: "RESULT_STORAGE_UPLOAD_FAILED",
    });
    return {
      ...job,
      status: "failed",
      error_message: "結果圖儲存失敗，請重新生成一次。",
      error_type: "result_storage",
      error_code: "RESULT_STORAGE_UPLOAD_FAILED",
    };
  }

  await updateJobStatus(job.id, {
    status: "success",
    result_image_url: resultPath,
  });
  let completedJob: TryOnJob = {
    ...job,
    status: "success",
    result_image_url: resultPath,
    error_message: null,
    error_type: null,
    error_code: null,
    provider_http_status: null,
  };

  if (enhanceOutcome.enhanced) {
    // 成本統計更新失敗只記錄，不讓已成功的結果對使用者變成失敗。
    const newCost = Number(completedJob.cost_estimate) + enhanceOutcome.extraCost;
    const { error: costError } = await supabase
      .from("try_on_jobs")
      .update({ cost_estimate: newCost, updated_at: new Date().toISOString() })
      .eq("id", completedJob.id);
    if (costError) {
      console.error(`更新放大成本失敗（job ${completedJob.id}）：`, costError.message);
    } else {
      completedJob = { ...completedJob, cost_estimate: newCost };
    }
  }

  return completedJob;
}

async function buildTryOnJobView(job: TryOnJob): Promise<TryOnJobView> {
  const [personImageUrl, resultImageUrl] = await Promise.all([
    job.person_image_url ? createSignedUrl(PERSON_BUCKET, job.person_image_url) : null,
    job.result_image_url ? createSignedUrl(RESULT_BUCKET, job.result_image_url) : null,
  ]);
  return {
    jobId: job.id,
    status: job.status,
    personImageUrl,
    resultImageUrl,
    costEstimate: Number(job.cost_estimate),
    retryCount: job.retry_count,
    ...(job.error_message ? { message: job.error_message } : {}),
  };
}

export async function startTryOnWorkflow(
  input: StartTryOnInput
): Promise<StartTryOnWorkflowResult> {
  if (!input.productId || !input.personImagePath) {
    return {
      ok: false,
      code: "missing_input",
      message: "缺少商品或人物照片資訊，請重新操作一次。",
    };
  }

  const providerName = resolveVTOProviderName(input.requestedModel);
  if (!providerName) {
    return {
      ok: false,
      code: "unsupported_model",
      message: "不支援的生成模型，請重新整理頁面後再選擇一次。",
    };
  }
  if (!isOwnedPersonImagePath(input.userId, input.personImagePath)) {
    return {
      ok: false,
      code: "invalid_person_image",
      message: "照片來源驗證失敗，請重新上傳照片。",
    };
  }

  if (input.seed !== undefined && !isValidGenerationSeed(input.seed)) {
    return {
      ok: false,
      code: "invalid_seed",
      message: "seed 必須是 0 到 4294967295 之間的整數。",
    };
  }
  if (input.idempotencyKey !== undefined && !isValidIdempotencyKey(input.idempotencyKey)) {
    return { ok: false, code: "invalid_idempotency_key", message: IDEMPOTENCY_KEY_ERROR_MESSAGE };
  }

  const requestFingerprint = input.idempotencyKey
    ? createTryOnRequestFingerprint({
        userId: input.userId,
        productId: input.productId,
        personImagePath: input.personImagePath,
        providerName,
        // Fingerprint 納入完整 resolved semantics；server-generated seed 用意圖標記取代隨機值。
        configSnapshot: resolveTryOnConfig(providerName, input.seed ?? 0).snapshot,
        explicitSeed: input.seed,
      })
    : undefined;

  // 一般 replay 快速路徑：不產生新 seed、不重讀商品、不占額度，也不碰 Provider。
  // DB RPC 仍會處理「兩個請求同時都沒查到」的競態，這裡不是唯一保證。
  if (input.idempotencyKey && requestFingerprint) {
    const existing = await findTryOnJobByIdempotency(input.userId, input.idempotencyKey);
    if (existing) {
      if (existing.request_fingerprint !== requestFingerprint) {
        return { ok: false, code: "idempotency_conflict", message: IDEMPOTENCY_CONFLICT_MESSAGE };
      }
      const quota = await checkGenerationQuota(input.userId, input.productId);
      return {
        ok: true,
        jobId: existing.id,
        status: "processing",
        costEstimate: Number(existing.cost_estimate),
        remainingToday: quota.remainingToday,
      };
    }
  }

  const supabase = getSupabaseAdmin();
  const { data: product } = await supabase
    .from("products")
    .select("*")
    .eq("id", input.productId)
    .eq("is_active", true)
    .single<Product>();
  if (!product) {
    return {
      ok: false,
      code: "product_not_found",
      message: "找不到這個商品，請重新整理頁面。",
    };
  }

  // 有 key 時不可被非原子的前置額度查詢搶先拒絕：同 key 的另一個 transaction
  // 可能剛建立 job，正確結果應由鎖內 RPC 判為 replay，而不是 429。
  if (!input.idempotencyKey) {
    const quota = await checkGenerationQuota(input.userId, input.productId);
    if (!quota.allowed) {
      return {
        ok: false,
        code: "quota_rejected",
        message: quota.reason ?? "已達生成上限。",
        remainingToday: quota.remainingToday,
      };
    }
  }

  const provider = getVTOProvider(providerName);
  const seed =
    input.seed ??
    (input.idempotencyKey && requestFingerprint
      ? createIdempotentGenerationSeed(input.idempotencyKey, requestFingerprint)
      : resolveGenerationSeed());
  const resolvedConfig = resolveTryOnConfig(provider.providerName, seed);
  const startedAt = new Date().toISOString();
  const budgetReservation =
    provider.costEstimate + getEnhancementCostEstimate(provider.providerName);
  const creation = await recordTryOnJob({
    userId: input.userId,
    productId: input.productId,
    personImagePath: input.personImagePath,
    garmentImageUrl: product.garment_image_url,
    provider: provider.providerName,
    costEstimate: provider.costEstimate,
    budgetReservation,
    seed,
    configSnapshot: resolvedConfig.snapshot,
    startedAt,
    idempotencyKey: input.idempotencyKey,
    requestFingerprint,
  });
  if (creation.outcome === "rejected") {
    return {
      ok: false,
      code: "quota_rejected",
      message: creation.reason ?? "已達生成上限。",
      remainingToday: creation.remainingToday,
    };
  }
  if (creation.outcome === "conflict") {
    return { ok: false, code: "idempotency_conflict", message: IDEMPOTENCY_CONFLICT_MESSAGE };
  }
  const job = creation.job;

  if (creation.outcome === "replayed") {
    return {
      ok: true,
      jobId: job.id,
      status: "processing",
      costEstimate: Number(job.cost_estimate),
      remainingToday: creation.remainingToday,
    };
  }

  let personImage: Buffer;
  try {
    const { data: personFile, error: downloadError } = await supabase.storage
      .from(PERSON_BUCKET)
      .download(input.personImagePath);
    if (downloadError || !personFile) {
      throw new Error("讀取不到剛上傳的照片，請重新上傳一次。");
    }
    personImage = Buffer.from(await personFile.arrayBuffer());
  } catch (cause) {
    const message = workflowErrorMessage(cause);
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: message,
      error_type: "person_image_read",
      error_code: "PERSON_IMAGE_DOWNLOAD_FAILED",
    });
    return { ok: false, code: "submission_failed", message, jobId: job.id };
  }

  let garmentImage: Buffer;
  try {
    garmentImage = await loadImageAsPngBuffer(product.garment_image_url);
  } catch (cause) {
    const message = workflowErrorMessage(cause);
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: message,
      error_type: "garment_image_read",
      error_code: "GARMENT_IMAGE_READ_FAILED",
    });
    return { ok: false, code: "submission_failed", message, jobId: job.id };
  }

  let providerJobId: string;
  try {
    const submission = await provider.submit({
      personImage,
      garmentImage,
      garmentType: "tops",
      generationConfig: resolvedConfig.provider,
    });
    providerJobId = submission.providerJobId;
  } catch (cause) {
    const message = workflowErrorMessage(cause);
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: message,
      error_type: "provider_submit",
      error_code: "PROVIDER_SUBMIT_FAILED",
      provider_http_status: cause instanceof VTOProviderError ? cause.httpStatus ?? null : null,
    });
    return { ok: false, code: "submission_failed", message, jobId: job.id };
  }

  try {
    await updateJobStatus(job.id, {
      status: "processing",
      provider_job_id: providerJobId,
    });
  } catch (cause) {
    // Provider 可能已接受並計費，但 provider_job_id 尚未持久化；不得重送或假裝 exactly-once。
    return {
      ok: false,
      code: "submission_failed",
      message: workflowErrorMessage(cause),
      jobId: job.id,
    };
  }
  return {
    ok: true,
    jobId: job.id,
    status: "processing",
    costEstimate: provider.costEstimate,
    remainingToday: creation.remainingToday,
  };
}

export async function getAndAdvanceTryOnWorkflow(
  input: GetAndAdvanceTryOnInput
): Promise<GetAndAdvanceTryOnWorkflowResult> {
  let job = await loadOwnedTryOnJob(input.jobId, input.userId);
  if (!job) {
    return { ok: false, code: "job_not_found", message: "找不到這筆試穿紀錄。" };
  }

  if ((job.status === "pending" || job.status === "processing") && job.provider_job_id) {
    const provider = getVTOProvider(job.provider);
    const pollContext = await buildPollContext(job, provider.requiresImagesOnPoll);
    if (!pollContext.ok) return pollContext;

    const polledAt = new Date().toISOString();
    await updateJobStatus(job.id, { last_polled_at: polledAt }, polledAt);
    let result: VTOStatusResult;
    try {
      result = await provider.checkStatus(job.provider_job_id, pollContext.context);
    } catch (cause) {
      const providerError = cause instanceof VTOProviderError ? cause : null;
      const errorType: TryOnErrorType =
        providerError?.stage === "provider_output_download"
          ? "provider_output_download"
          : "provider_poll";
      await updateJobStatus(job.id, {
        status: "failed",
        error_message: workflowErrorMessage(cause),
        error_type: errorType,
        error_code:
          errorType === "provider_output_download"
            ? "PROVIDER_OUTPUT_DOWNLOAD_FAILED"
            : "PROVIDER_POLL_FAILED",
        provider_http_status: providerError?.httpStatus ?? null,
      });
      throw cause;
    }
    if (result.status === "success") {
      job = await finalizeSuccessfulJob(job, result.resultImage);
    } else if (result.status === "failed") {
      await updateJobStatus(job.id, {
        status: "failed",
        error_message: result.errorMessage,
        error_type: "provider_rejected",
        error_code: result.errorCode ?? "PROVIDER_REJECTED",
        provider_http_status: result.providerHttpStatus ?? null,
      });
      job = {
        ...job,
        status: "failed",
        error_message: result.errorMessage,
        error_type: "provider_rejected",
        error_code: result.errorCode ?? "PROVIDER_REJECTED",
        provider_http_status: result.providerHttpStatus ?? null,
      };
    }
  }

  return { ok: true, view: await buildTryOnJobView(job) };
}
