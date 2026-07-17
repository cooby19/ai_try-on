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
import type { Product, TryOnJob } from "../types";
import { isOwnedPersonImagePath } from "../upload-intent";
import { toJpegUploadBlob } from "../validation";
import { getVTOProvider, resolveVTOProviderName } from "../vto";
import { resolveGenerationSeed, resolveTryOnConfig } from "./config";
import {
  createTryOnWorkflow,
  type GetAndAdvanceTryOnInput,
  type StartTryOnInput,
} from "./workflow-core";

export type {
  GetAndAdvanceTryOnInput,
  GetAndAdvanceTryOnWorkflowResult,
  StartTryOnInput,
  StartTryOnWorkflowResult,
  TryOnWorkflowDependencies,
} from "./workflow-core";

const productionWorkflow = createTryOnWorkflow({
  now: () => new Date().toISOString(),
  generateSeed: () => resolveGenerationSeed(),
  resolveProviderName: resolveVTOProviderName,
  resolveConfig: resolveTryOnConfig,
  isOwnedPersonImagePath,
  findJobByIdempotency: findTryOnJobByIdempotency,
  checkQuota: checkGenerationQuota,
  async loadProduct(productId): Promise<Product | null> {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("products")
      .select("*")
      .eq("id", productId)
      .eq("is_active", true)
      .single<Product>();
    return data ?? null;
  },
  getProvider: getVTOProvider,
  getEnhancementCostEstimate,
  recordJob: recordTryOnJob,
  updateJobStatus,
  async downloadPersonImage(path): Promise<Buffer> {
    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(PERSON_BUCKET).download(path);
    if (error || !data) {
      throw new Error("讀取不到剛上傳的照片，請重新上傳一次。");
    }
    return Buffer.from(await data.arrayBuffer());
  },
  loadGarmentImage: loadImageAsPngBuffer,
  async loadOwnedJob(jobId, userId): Promise<TryOnJob | null> {
    const supabase = getSupabaseAdmin();
    const { data } = await supabase
      .from("try_on_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("user_id", userId)
      .single<TryOnJob>();
    return data ?? null;
  },
  enhanceResultImage,
  async uploadResultImage(path, image): Promise<{ message: string } | null> {
    const supabase = getSupabaseAdmin();
    const uploadBody = toJpegUploadBlob(image);
    const { error } = await supabase.storage
      .from(RESULT_BUCKET)
      .upload(path, uploadBody, { contentType: "image/jpeg", upsert: true });
    return error;
  },
  async updateJobCost(jobId, costEstimate, updatedAt): Promise<string | null> {
    const supabase = getSupabaseAdmin();
    const { error } = await supabase
      .from("try_on_jobs")
      .update({ cost_estimate: costEstimate, updated_at: updatedAt })
      .eq("id", jobId);
    return error?.message ?? null;
  },
  createPersonSignedUrl: (path) => createSignedUrl(PERSON_BUCKET, path),
  createResultSignedUrl: (path) => createSignedUrl(RESULT_BUCKET, path),
  logCostUpdateError(jobId, message) {
    console.error(`更新放大成本失敗（job ${jobId}）：`, message);
  },
});

export function startTryOnWorkflow(input: StartTryOnInput) {
  return productionWorkflow.startTryOnWorkflow(input);
}

export function getAndAdvanceTryOnWorkflow(input: GetAndAdvanceTryOnInput) {
  return productionWorkflow.getAndAdvanceTryOnWorkflow(input);
}
