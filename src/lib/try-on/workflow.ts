import "server-only";

import { enhanceResultImage, getEnhancementCostEstimate } from "../enhance";
import { loadImageAsPngBuffer } from "../images";
import {
  checkGenerationQuota,
  recordTryOnJob,
  updateJobStatus,
} from "../quota";
import {
  createSignedUrl,
  getSupabaseAdmin,
  PERSON_BUCKET,
  RESULT_BUCKET,
} from "../supabase";
import type { Product, TryOnJob, TryOnJobView } from "../types";
import { isOwnedPersonImagePath } from "../upload-intent";
import { toJpegUploadBlob } from "../validation";
import { getVTOProvider, resolveVTOProviderName } from "../vto";
import type { VTOSubmitInput } from "../vto/provider";

export interface StartTryOnInput {
  userId: string;
  productId?: string;
  personImagePath?: string;
  requestedModel?: unknown;
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
  | { ok: true; context?: VTOSubmitInput }
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
  const enhanceOutcome = await enhanceResultImage(resultImage, job.provider);
  const resultPath = `${job.user_id}/${job.id}.jpg`;
  const supabase = getSupabaseAdmin();
  const uploadBody = toJpegUploadBlob(enhanceOutcome.image);
  const { error: uploadError } = await supabase.storage
    .from(RESULT_BUCKET)
    .upload(resultPath, uploadBody, { contentType: "image/jpeg", upsert: true });

  if (uploadError) {
    await updateJobStatus(job.id, {
      status: "failed",
      error_message: `結果圖儲存失敗：${uploadError.message}`,
    });
    return {
      ...job,
      status: "failed",
      error_message: "結果圖儲存失敗，請重新生成一次。",
    };
  }

  await updateJobStatus(job.id, { status: "success", result_image_url: resultPath });
  let completedJob: TryOnJob = { ...job, status: "success", result_image_url: resultPath };

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

  const quota = await checkGenerationQuota(input.userId, input.productId);
  if (!quota.allowed) {
    return {
      ok: false,
      code: "quota_rejected",
      message: quota.reason ?? "已達生成上限。",
      remainingToday: quota.remainingToday,
    };
  }

  const provider = getVTOProvider(providerName);
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
  });
  if (!creation.allowed || !creation.job) {
    return {
      ok: false,
      code: "quota_rejected",
      message: creation.reason ?? "已達生成上限。",
      remainingToday: creation.remainingToday,
    };
  }
  const job = creation.job;

  try {
    const { data: personFile, error: downloadError } = await supabase.storage
      .from(PERSON_BUCKET)
      .download(input.personImagePath);
    if (downloadError || !personFile) {
      throw new Error("讀取不到剛上傳的照片，請重新上傳一次。");
    }
    const personImage = Buffer.from(await personFile.arrayBuffer());
    const garmentImage = await loadImageAsPngBuffer(product.garment_image_url);
    const { providerJobId } = await provider.submit({
      personImage,
      garmentImage,
      garmentType: "tops",
    });

    await updateJobStatus(job.id, {
      status: "processing",
      provider_job_id: providerJobId,
    });
    return {
      ok: true,
      jobId: job.id,
      status: "processing",
      costEstimate: provider.costEstimate,
      remainingToday: creation.remainingToday,
    };
  } catch (cause) {
    const message = workflowErrorMessage(cause);
    await updateJobStatus(job.id, { status: "failed", error_message: message });
    return { ok: false, code: "submission_failed", message, jobId: job.id };
  }
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

    const result = await provider.checkStatus(job.provider_job_id, pollContext.context);
    if (result.status === "success") {
      job = await finalizeSuccessfulJob(job, result.resultImage);
    } else if (result.status === "failed") {
      await updateJobStatus(job.id, {
        status: "failed",
        error_message: result.errorMessage,
      });
      job = { ...job, status: "failed", error_message: result.errorMessage };
    }
  }

  return { ok: true, view: await buildTryOnJobView(job) };
}
