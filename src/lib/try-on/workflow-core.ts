import type { EnhanceOutcome } from "../enhance";
import type { AtomicJobCreationResult, QuotaCheck } from "../quota";
import type {
  JobStatus,
  Product,
  TryOnErrorType,
  TryOnJob,
  TryOnJobView,
} from "../types";
import type { VTOProvider, VTOImageInput, VTOStatusResult } from "../vto/provider";
import { VTOProviderError } from "../vto/provider";
import type { ResolvedTryOnConfig } from "./config";
import { isValidGenerationSeed } from "./config";
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

export type TryOnJobStatusUpdate = Partial<{
  status: JobStatus;
  provider_job_id: string;
  result_image_url: string;
  error_message: string | null;
  error_type: TryOnErrorType | null;
  error_code: string | null;
  provider_http_status: number | null;
  last_polled_at: string;
}>;

/**
 * Workflow 的所有 I/O seam。正式 Route 與 deterministic runner 都執行下方同一份編排；
 * 差別只在這組依賴連到 Supabase/Provider，或連到固定的 in-memory adapter。
 */
export interface TryOnWorkflowDependencies {
  now(): string;
  generateSeed(): number;
  resolveProviderName(requestedModel?: unknown): string | null;
  resolveConfig(providerName: string, seed: number): ResolvedTryOnConfig;
  isOwnedPersonImagePath(userId: string, personImagePath: string): boolean;
  findJobByIdempotency(userId: string, idempotencyKey: string): Promise<TryOnJob | null>;
  checkQuota(userId: string, productId: string): Promise<QuotaCheck>;
  loadProduct(productId: string): Promise<Product | null>;
  getProvider(providerName: string): VTOProvider;
  getEnhancementCostEstimate(providerName: string): number;
  recordJob(input: {
    userId: string;
    productId: string;
    personImagePath: string;
    garmentImageUrl: string;
    provider: string;
    costEstimate: number;
    budgetReservation: number;
    seed: number;
    configSnapshot: ResolvedTryOnConfig["snapshot"];
    startedAt: string;
    idempotencyKey?: string;
    requestFingerprint?: string;
  }): Promise<AtomicJobCreationResult>;
  updateJobStatus(
    jobId: string,
    fields: TryOnJobStatusUpdate,
    eventAt?: string,
  ): Promise<void>;
  downloadPersonImage(path: string): Promise<Buffer>;
  loadGarmentImage(path: string): Promise<Buffer>;
  loadOwnedJob(jobId: string, userId: string): Promise<TryOnJob | null>;
  enhanceResultImage(image: Buffer, providerName: string): Promise<EnhanceOutcome>;
  uploadResultImage(path: string, image: Buffer): Promise<{ message: string } | null>;
  updateJobCost(jobId: string, costEstimate: number, updatedAt: string): Promise<string | null>;
  createPersonSignedUrl(path: string): Promise<string | null>;
  createResultSignedUrl(path: string): Promise<string | null>;
  logCostUpdateError(jobId: string, message: string): void;
}

function workflowErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "發生未知錯誤";
}

export function createTryOnWorkflow(deps: TryOnWorkflowDependencies) {
  type PollContextResult =
    | { ok: true; context?: VTOImageInput }
    | { ok: false; code: "source_image_removed"; message: string };

  async function buildPollContext(
    job: TryOnJob,
    requiresImagesOnPoll: boolean,
  ): Promise<PollContextResult> {
    if (!requiresImagesOnPoll) return { ok: true };
    if (!job.person_image_url) {
      await deps.updateJobStatus(job.id, {
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

    let personImage: Buffer;
    try {
      personImage = await deps.downloadPersonImage(job.person_image_url);
    } catch {
      // 保持既有語意：poll context 的暫時下載失敗不立刻終結 job，讓後續輪詢可重試。
      return { ok: true };
    }
    return {
      ok: true,
      context: {
        personImage,
        garmentImage: await deps.loadGarmentImage(job.garment_image_url),
        garmentType: "tops",
      },
    };
  }

  async function finalizeSuccessfulJob(job: TryOnJob, resultImage: Buffer): Promise<TryOnJob> {
    let enhanceOutcome: EnhanceOutcome;
    try {
      enhanceOutcome = await deps.enhanceResultImage(resultImage, job.provider);
    } catch (cause) {
      await deps.updateJobStatus(job.id, {
        status: "failed",
        error_message: workflowErrorMessage(cause),
        error_type: "internal",
        error_code: "INTERNAL_ERROR",
      });
      throw cause;
    }
    const resultPath = `${job.user_id}/${job.id}.jpg`;
    let uploadError: { message: string } | null;
    try {
      uploadError = await deps.uploadResultImage(resultPath, enhanceOutcome.image);
    } catch (cause) {
      uploadError = { message: workflowErrorMessage(cause) };
    }

    if (uploadError) {
      await deps.updateJobStatus(job.id, {
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

    await deps.updateJobStatus(job.id, {
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
      const newCost = Number(completedJob.cost_estimate) + enhanceOutcome.extraCost;
      const costError = await deps.updateJobCost(completedJob.id, newCost, deps.now());
      if (costError) {
        deps.logCostUpdateError(completedJob.id, costError);
      } else {
        completedJob = { ...completedJob, cost_estimate: newCost };
      }
    }
    return completedJob;
  }

  async function buildTryOnJobView(job: TryOnJob): Promise<TryOnJobView> {
    const [personImageUrl, resultImageUrl] = await Promise.all([
      job.person_image_url ? deps.createPersonSignedUrl(job.person_image_url) : null,
      job.result_image_url ? deps.createResultSignedUrl(job.result_image_url) : null,
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

  async function startTryOnWorkflow(
    input: StartTryOnInput,
  ): Promise<StartTryOnWorkflowResult> {
    if (!input.productId || !input.personImagePath) {
      return {
        ok: false,
        code: "missing_input",
        message: "缺少商品或人物照片資訊，請重新操作一次。",
      };
    }

    const providerName = deps.resolveProviderName(input.requestedModel);
    if (!providerName) {
      return {
        ok: false,
        code: "unsupported_model",
        message: "不支援的生成模型，請重新整理頁面後再選擇一次。",
      };
    }
    if (!deps.isOwnedPersonImagePath(input.userId, input.personImagePath)) {
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
      return {
        ok: false,
        code: "invalid_idempotency_key",
        message: IDEMPOTENCY_KEY_ERROR_MESSAGE,
      };
    }

    const requestFingerprint = input.idempotencyKey
      ? createTryOnRequestFingerprint({
          userId: input.userId,
          productId: input.productId,
          personImagePath: input.personImagePath,
          providerName,
          configSnapshot: deps.resolveConfig(providerName, input.seed ?? 0).snapshot,
          explicitSeed: input.seed,
        })
      : undefined;

    if (input.idempotencyKey && requestFingerprint) {
      const existing = await deps.findJobByIdempotency(input.userId, input.idempotencyKey);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          return {
            ok: false,
            code: "idempotency_conflict",
            message: IDEMPOTENCY_CONFLICT_MESSAGE,
          };
        }
        const quota = await deps.checkQuota(input.userId, input.productId);
        return {
          ok: true,
          jobId: existing.id,
          status: "processing",
          costEstimate: Number(existing.cost_estimate),
          remainingToday: quota.remainingToday,
        };
      }
    }

    const product = await deps.loadProduct(input.productId);
    if (!product) {
      return {
        ok: false,
        code: "product_not_found",
        message: "找不到這個商品，請重新整理頁面。",
      };
    }

    if (!input.idempotencyKey) {
      const quota = await deps.checkQuota(input.userId, input.productId);
      if (!quota.allowed) {
        return {
          ok: false,
          code: "quota_rejected",
          message: quota.reason ?? "已達生成上限。",
          remainingToday: quota.remainingToday,
        };
      }
    }

    const provider = deps.getProvider(providerName);
    const seed =
      input.seed ??
      (input.idempotencyKey && requestFingerprint
        ? createIdempotentGenerationSeed(input.idempotencyKey, requestFingerprint)
        : deps.generateSeed());
    const resolvedConfig = deps.resolveConfig(provider.providerName, seed);
    const startedAt = deps.now();
    const budgetReservation =
      provider.costEstimate + deps.getEnhancementCostEstimate(provider.providerName);
    const creation = await deps.recordJob({
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
      return {
        ok: false,
        code: "idempotency_conflict",
        message: IDEMPOTENCY_CONFLICT_MESSAGE,
      };
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
      personImage = await deps.downloadPersonImage(input.personImagePath);
    } catch (cause) {
      const message = workflowErrorMessage(cause);
      await deps.updateJobStatus(job.id, {
        status: "failed",
        error_message: message,
        error_type: "person_image_read",
        error_code: "PERSON_IMAGE_DOWNLOAD_FAILED",
      });
      return { ok: false, code: "submission_failed", message, jobId: job.id };
    }

    let garmentImage: Buffer;
    try {
      garmentImage = await deps.loadGarmentImage(product.garment_image_url);
    } catch (cause) {
      const message = workflowErrorMessage(cause);
      await deps.updateJobStatus(job.id, {
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
      await deps.updateJobStatus(job.id, {
        status: "failed",
        error_message: message,
        error_type: "provider_submit",
        error_code: "PROVIDER_SUBMIT_FAILED",
        provider_http_status: cause instanceof VTOProviderError ? cause.httpStatus ?? null : null,
      });
      return { ok: false, code: "submission_failed", message, jobId: job.id };
    }

    try {
      await deps.updateJobStatus(job.id, {
        status: "processing",
        provider_job_id: providerJobId,
      });
    } catch (cause) {
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

  async function getAndAdvanceTryOnWorkflow(
    input: GetAndAdvanceTryOnInput,
  ): Promise<GetAndAdvanceTryOnWorkflowResult> {
    let job = await deps.loadOwnedJob(input.jobId, input.userId);
    if (!job) {
      return { ok: false, code: "job_not_found", message: "找不到這筆試穿紀錄。" };
    }

    if ((job.status === "pending" || job.status === "processing") && job.provider_job_id) {
      const provider = deps.getProvider(job.provider);
      const pollContext = await buildPollContext(job, provider.requiresImagesOnPoll);
      if (!pollContext.ok) return pollContext;

      const polledAt = deps.now();
      await deps.updateJobStatus(job.id, { last_polled_at: polledAt }, polledAt);
      let result: VTOStatusResult;
      try {
        result = await provider.checkStatus(job.provider_job_id, pollContext.context);
      } catch (cause) {
        const providerError = cause instanceof VTOProviderError ? cause : null;
        const errorType: TryOnErrorType =
          providerError?.stage === "provider_output_download"
            ? "provider_output_download"
            : "provider_poll";
        await deps.updateJobStatus(job.id, {
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
        await deps.updateJobStatus(job.id, {
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

  return { startTryOnWorkflow, getAndAdvanceTryOnWorkflow };
}
