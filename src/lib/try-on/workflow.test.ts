import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enhanceResultImage, getEnhancementCostEstimate } from "@/lib/enhance";
import { loadImageAsPngBuffer } from "@/lib/images";
import {
  checkGenerationQuota,
  recordTryOnJob,
  updateJobStatus,
} from "@/lib/quota";
import { createSignedUrl, getSupabaseAdmin } from "@/lib/supabase";
import type { Product, TryOnJob } from "@/lib/types";
import { isOwnedPersonImagePath } from "@/lib/upload-intent";
import { toJpegUploadBlob } from "@/lib/validation";
import { getVTOProvider, resolveVTOProviderName } from "@/lib/vto";
import type { VTOProvider } from "@/lib/vto/provider";
import {
  getAndAdvanceTryOnWorkflow,
  startTryOnWorkflow,
} from "@/lib/try-on/workflow";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/enhance", () => ({
  enhanceResultImage: vi.fn(),
  getEnhancementCostEstimate: vi.fn(),
}));
vi.mock("@/lib/images", () => ({ loadImageAsPngBuffer: vi.fn() }));
vi.mock("@/lib/quota", () => ({
  checkGenerationQuota: vi.fn(),
  recordTryOnJob: vi.fn(),
  updateJobStatus: vi.fn(),
}));
vi.mock("@/lib/supabase", () => ({
  PERSON_BUCKET: "person-uploads",
  RESULT_BUCKET: "try-on-results",
  createSignedUrl: vi.fn(),
  getSupabaseAdmin: vi.fn(),
}));
vi.mock("@/lib/upload-intent", () => ({ isOwnedPersonImagePath: vi.fn() }));
vi.mock("@/lib/validation", () => ({ toJpegUploadBlob: vi.fn() }));
vi.mock("@/lib/vto", () => ({
  getVTOProvider: vi.fn(),
  resolveVTOProviderName: vi.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const PERSON_PATH = `${USER_ID}/44444444-4444-4444-8444-444444444444.jpg`;
const GARMENT_PATH = "/garments/white-tee.svg";
const PERSON_BYTES = Buffer.from("person-image");
const GARMENT_BYTES = Buffer.from("garment-image");
const RESULT_BYTES = Buffer.from("result-image");

function makeProduct(overrides: Partial<Product> = {}): Product {
  return {
    id: PRODUCT_ID,
    name: "白色上衣",
    price: 1200,
    image_url: "/products/white-tee.svg",
    garment_image_url: GARMENT_PATH,
    category: "tops",
    color: "white",
    fit: null,
    material: null,
    size_chart: null,
    is_active: true,
    created_at: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeJob(overrides: Partial<TryOnJob> = {}): TryOnJob {
  return {
    id: JOB_ID,
    user_id: USER_ID,
    source_hash: null,
    product_id: PRODUCT_ID,
    person_image_url: PERSON_PATH,
    garment_image_url: GARMENT_PATH,
    result_image_url: null,
    provider: "fashn",
    provider_job_id: "provider-job-id",
    status: "processing",
    cost_estimate: 0.075,
    budget_reservation: 0.08,
    retry_count: 1,
    error_message: null,
    created_at: "2026-07-17T01:00:00.000Z",
    updated_at: "2026-07-17T01:00:00.000Z",
    ...overrides,
  };
}

function storageFile(bytes: Buffer): Blob {
  return new Blob([Uint8Array.from(bytes)], { type: "image/jpeg" });
}

interface SupabaseOptions {
  product?: Product | null;
  ownedJob?: TryOnJob | null;
  personFile?: Blob | null;
  personDownloadError?: { message: string } | null;
  uploadError?: { message: string } | null;
  costError?: { message: string } | null;
}

function installSupabase(options: SupabaseOptions = {}) {
  const product = options.product === undefined ? makeProduct() : options.product;
  const ownedJob = options.ownedJob === undefined ? makeJob() : options.ownedJob;
  const personFile = options.personFile === undefined ? storageFile(PERSON_BYTES) : options.personFile;

  const productSingle = vi.fn().mockResolvedValue({ data: product, error: null });
  const productActiveEq = vi.fn().mockReturnValue({ single: productSingle });
  const productIdEq = vi.fn().mockReturnValue({ eq: productActiveEq });
  const productSelect = vi.fn().mockReturnValue({ eq: productIdEq });

  const jobSingle = vi.fn().mockResolvedValue({ data: ownedJob, error: null });
  const jobUserEq = vi.fn().mockReturnValue({ single: jobSingle });
  const jobIdEq = vi.fn().mockReturnValue({ eq: jobUserEq });
  const jobSelect = vi.fn().mockReturnValue({ eq: jobIdEq });

  const costEq = vi.fn().mockResolvedValue({ error: options.costError ?? null });
  const update = vi.fn().mockReturnValue({ eq: costEq });
  const from = vi.fn((table: string) => {
    if (table === "products") return { select: productSelect };
    if (table === "try_on_jobs") return { select: jobSelect, update };
    throw new Error(`unexpected table: ${table}`);
  });

  const personDownload = vi.fn().mockResolvedValue({
    data: personFile,
    error: options.personDownloadError ?? null,
  });
  const resultUpload = vi.fn().mockResolvedValue({ error: options.uploadError ?? null });
  const storageFrom = vi.fn((bucket: string) => {
    if (bucket === "person-uploads") return { download: personDownload };
    if (bucket === "try-on-results") return { upload: resultUpload };
    throw new Error(`unexpected bucket: ${bucket}`);
  });

  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from,
    storage: { from: storageFrom },
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return {
    from,
    productIdEq,
    productActiveEq,
    jobIdEq,
    jobUserEq,
    update,
    costEq,
    personDownload,
    resultUpload,
    storageFrom,
  };
}

function installProvider(overrides: Partial<VTOProvider> = {}) {
  const submit = vi.fn().mockResolvedValue({ providerJobId: "submitted-provider-job-id" });
  const checkStatus = vi.fn().mockResolvedValue({ status: "processing" as const });
  const provider: VTOProvider = {
    providerName: "fashn",
    costEstimate: 0.075,
    requiresImagesOnPoll: false,
    submit,
    checkStatus,
    ...overrides,
  };
  vi.mocked(getVTOProvider).mockReturnValue(provider);
  return { provider, submit, checkStatus };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("測試不允許外部 fetch");
    })
  );
  installSupabase();
  installProvider();
  vi.mocked(resolveVTOProviderName).mockReturnValue("fashn");
  vi.mocked(isOwnedPersonImagePath).mockReturnValue(true);
  vi.mocked(checkGenerationQuota).mockResolvedValue({
    allowed: true,
    usedToday: 0,
    remainingToday: 3,
    productAttemptsToday: 0,
    remainingRetriesForProduct: 3,
  });
  vi.mocked(recordTryOnJob).mockResolvedValue({
    allowed: true,
    remainingToday: 2,
    job: makeJob({ status: "pending", provider_job_id: null, retry_count: 0 }),
  });
  vi.mocked(updateJobStatus).mockResolvedValue(undefined);
  vi.mocked(getEnhancementCostEstimate).mockReturnValue(0.005);
  vi.mocked(loadImageAsPngBuffer).mockResolvedValue(GARMENT_BYTES);
  vi.mocked(enhanceResultImage).mockResolvedValue({
    image: RESULT_BYTES,
    enhanced: false,
    extraCost: 0,
  });
  vi.mocked(toJpegUploadBlob).mockReturnValue(storageFile(RESULT_BYTES));
  vi.mocked(createSignedUrl).mockImplementation(async (bucket, path) => `signed://${bucket}/${path}`);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startTryOnWorkflow", () => {
  const input = {
    userId: USER_ID,
    productId: PRODUCT_ID,
    personImagePath: PERSON_PATH,
    requestedModel: "v1.6",
  };

  it("合法輸入建立 Job、載入兩張圖片並提交 Provider", async () => {
    const database = installSupabase();
    const provider = installProvider();

    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: true,
      jobId: JOB_ID,
      status: "processing",
      costEstimate: 0.075,
      remainingToday: 2,
    });
    expect(recordTryOnJob).toHaveBeenCalledWith({
      userId: USER_ID,
      productId: PRODUCT_ID,
      personImagePath: PERSON_PATH,
      garmentImageUrl: GARMENT_PATH,
      provider: "fashn",
      costEstimate: 0.075,
      budgetReservation: 0.08,
    });
    expect(database.personDownload).toHaveBeenCalledWith(PERSON_PATH);
    expect(loadImageAsPngBuffer).toHaveBeenCalledWith(GARMENT_PATH);
    expect(provider.submit).toHaveBeenCalledWith({
      personImage: PERSON_BYTES,
      garmentImage: GARMENT_BYTES,
      garmentType: "tops",
    });
  });

  it("不支援的 model 在建立 Job 前被拒絕", async () => {
    vi.mocked(resolveVTOProviderName).mockReturnValue(null);
    const result = await startTryOnWorkflow({ ...input, requestedModel: "arbitrary-provider" });

    expect(result).toEqual({
      ok: false,
      code: "unsupported_model",
      message: "不支援的生成模型，請重新整理頁面後再選擇一次。",
    });
    expect(recordTryOnJob).not.toHaveBeenCalled();
    expect(getVTOProvider).not.toHaveBeenCalled();
  });

  it("非本人或不合法的 personImagePath 在查商品前被拒絕", async () => {
    vi.mocked(isOwnedPersonImagePath).mockReturnValue(false);
    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "invalid_person_image",
      message: "照片來源驗證失敗，請重新上傳照片。",
    });
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
    expect(recordTryOnJob).not.toHaveBeenCalled();
  });

  it("商品不存在或未啟用時被拒絕", async () => {
    const database = installSupabase({ product: null });
    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "product_not_found",
      message: "找不到這個商品，請重新整理頁面。",
    });
    expect(database.productIdEq).toHaveBeenCalledWith("id", PRODUCT_ID);
    expect(database.productActiveEq).toHaveBeenCalledWith("is_active", true);
    expect(checkGenerationQuota).not.toHaveBeenCalled();
  });

  it("前置額度不足時不建立 Job 或呼叫 Provider", async () => {
    vi.mocked(checkGenerationQuota).mockResolvedValue({
      allowed: false,
      reason: "額度已用完",
      usedToday: 3,
      remainingToday: 0,
      productAttemptsToday: 1,
      remainingRetriesForProduct: 2,
    });
    const provider = installProvider();

    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "quota_rejected",
      message: "額度已用完",
      remainingToday: 0,
    });
    expect(recordTryOnJob).not.toHaveBeenCalled();
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("原子 Job 建立被拒絕時不呼叫 Provider", async () => {
    vi.mocked(recordTryOnJob).mockResolvedValue({
      allowed: false,
      reason: "平台預算已達上限",
      remainingToday: 1,
    });
    const provider = installProvider();

    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "quota_rejected",
      message: "平台預算已達上限",
      remainingToday: 1,
    });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("人物照下載失敗時將已建立 Job 標記 failed", async () => {
    installSupabase({ personFile: null, personDownloadError: { message: "storage down" } });
    const provider = installProvider();

    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "submission_failed",
      message: "讀取不到剛上傳的照片，請重新上傳一次。",
      jobId: JOB_ID,
    });
    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error_message: "讀取不到剛上傳的照片，請重新上傳一次。",
    });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("商品圖載入失敗時將已建立 Job 標記 failed", async () => {
    vi.mocked(loadImageAsPngBuffer).mockRejectedValue(new Error("商品圖無法讀取"));
    const provider = installProvider();

    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "submission_failed",
      message: "商品圖無法讀取",
      jobId: JOB_ID,
    });
    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error_message: "商品圖無法讀取",
    });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("provider.submit 失敗時將 Job 標記 failed", async () => {
    const provider = installProvider();
    provider.submit.mockRejectedValue(new Error("provider unavailable"));

    const result = await startTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "submission_failed",
      message: "provider unavailable",
      jobId: JOB_ID,
    });
    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error_message: "provider unavailable",
    });
  });

  it("成功時保存 provider_job_id 並轉成 processing", async () => {
    const result = await startTryOnWorkflow(input);

    expect(result.ok).toBe(true);
    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "processing",
      provider_job_id: "submitted-provider-job-id",
    });
    expect(updateJobStatus).toHaveBeenCalledTimes(1);
  });
});

describe("getAndAdvanceTryOnWorkflow", () => {
  const input = { userId: USER_ID, jobId: JOB_ID };

  it("查不到本人 Job 時回既有 not found，且查詢同時包含 jobId 與 userId", async () => {
    const database = installSupabase({ ownedJob: null });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(result).toEqual({
      ok: false,
      code: "job_not_found",
      message: "找不到這筆試穿紀錄。",
    });
    expect(database.jobIdEq).toHaveBeenCalledWith("id", JOB_ID);
    expect(database.jobUserEq).toHaveBeenCalledWith("user_id", USER_ID);
    expect(getVTOProvider).not.toHaveBeenCalled();
  });

  it("Provider processing 時不寫入 Storage 或標記 success", async () => {
    const database = installSupabase();
    const provider = installProvider();

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(result).toMatchObject({ ok: true, view: { status: "processing" } });
    expect(provider.checkStatus).toHaveBeenCalledWith("provider-job-id", undefined);
    expect(database.resultUpload).not.toHaveBeenCalled();
    expect(updateJobStatus).not.toHaveBeenCalled();
  });

  it("Provider terminal failed 時將 Job 更新為 failed", async () => {
    const provider = installProvider();
    provider.checkStatus.mockResolvedValue({ status: "failed", errorMessage: "生成失敗" });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error_message: "生成失敗",
    });
    expect(result).toMatchObject({
      ok: true,
      view: { status: "failed", message: "生成失敗" },
    });
  });

  it("Provider success 時執行 enhance、上傳 JPEG 並更新 success", async () => {
    const database = installSupabase();
    const provider = installProvider();
    provider.checkStatus.mockResolvedValue({ status: "success", resultImage: RESULT_BYTES });
    const uploadBlob = storageFile(Buffer.from("jpeg-result"));
    vi.mocked(toJpegUploadBlob).mockReturnValue(uploadBlob);

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(enhanceResultImage).toHaveBeenCalledWith(RESULT_BYTES, "fashn");
    expect(toJpegUploadBlob).toHaveBeenCalledWith(RESULT_BYTES);
    expect(database.resultUpload).toHaveBeenCalledWith(
      `${USER_ID}/${JOB_ID}.jpg`,
      uploadBlob,
      { contentType: "image/jpeg", upsert: true }
    );
    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "success",
      result_image_url: `${USER_ID}/${JOB_ID}.jpg`,
    });
    expect(result).toMatchObject({ ok: true, view: { status: "success" } });
  });

  it("結果圖 Storage 上傳失敗時將 Job 更新為 failed", async () => {
    installSupabase({ uploadError: { message: "bucket unavailable" } });
    const provider = installProvider();
    provider.checkStatus.mockResolvedValue({ status: "success", resultImage: RESULT_BYTES });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error_message: "結果圖儲存失敗：bucket unavailable",
    });
    expect(result).toMatchObject({
      ok: true,
      view: {
        status: "failed",
        resultImageUrl: null,
        message: "結果圖儲存失敗，請重新生成一次。",
      },
    });
  });

  it("enhance 失敗降級 outcome 仍上傳原圖並標記 success", async () => {
    const database = installSupabase();
    const provider = installProvider();
    provider.checkStatus.mockResolvedValue({ status: "success", resultImage: RESULT_BYTES });
    vi.mocked(enhanceResultImage).mockResolvedValue({
      image: RESULT_BYTES,
      enhanced: false,
      extraCost: 0,
    });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(toJpegUploadBlob).toHaveBeenCalledWith(RESULT_BYTES);
    expect(database.resultUpload).toHaveBeenCalledOnce();
    expect(database.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, view: { status: "success", costEstimate: 0.075 } });
  });

  it("enhance 成功時更新實際成本並回傳新成本", async () => {
    const database = installSupabase();
    const provider = installProvider();
    provider.checkStatus.mockResolvedValue({ status: "success", resultImage: RESULT_BYTES });
    const enhancedBytes = Buffer.from("enhanced-image");
    vi.mocked(enhanceResultImage).mockResolvedValue({
      image: enhancedBytes,
      enhanced: true,
      extraCost: 0.005,
    });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(toJpegUploadBlob).toHaveBeenCalledWith(enhancedBytes);
    expect(database.update).toHaveBeenCalledWith(expect.objectContaining({ cost_estimate: 0.08 }));
    expect(database.costEq).toHaveBeenCalledWith("id", JOB_ID);
    expect(result).toMatchObject({ ok: true, view: { status: "success", costEstimate: 0.08 } });
  });

  it("requiresImagesOnPoll=true 時載入人物照與商品圖作為 poll context", async () => {
    const database = installSupabase();
    const provider = installProvider({ requiresImagesOnPoll: true });

    await getAndAdvanceTryOnWorkflow(input);

    expect(database.personDownload).toHaveBeenCalledWith(PERSON_PATH);
    expect(loadImageAsPngBuffer).toHaveBeenCalledWith(GARMENT_PATH);
    expect(provider.checkStatus).toHaveBeenCalledWith("provider-job-id", {
      personImage: PERSON_BYTES,
      garmentImage: GARMENT_BYTES,
      garmentType: "tops",
    });
  });

  it("requiresImagesOnPoll=false 時不重複下載原始圖片", async () => {
    const database = installSupabase();
    const provider = installProvider({ requiresImagesOnPoll: false });

    await getAndAdvanceTryOnWorkflow(input);

    expect(database.personDownload).not.toHaveBeenCalled();
    expect(loadImageAsPngBuffer).not.toHaveBeenCalled();
    expect(provider.checkStatus).toHaveBeenCalledWith("provider-job-id", undefined);
  });

  it("建立兩張 signed URL 並保持完整 TryOnJobView 欄位", async () => {
    installSupabase({
      ownedJob: makeJob({
        status: "success",
        result_image_url: `${USER_ID}/${JOB_ID}.jpg`,
        provider_job_id: null,
        retry_count: 2,
        error_message: "保留訊息",
      }),
    });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(result).toEqual({
      ok: true,
      view: {
        jobId: JOB_ID,
        status: "success",
        personImageUrl: `signed://person-uploads/${PERSON_PATH}`,
        resultImageUrl: `signed://try-on-results/${USER_ID}/${JOB_ID}.jpg`,
        costEstimate: 0.075,
        retryCount: 2,
        message: "保留訊息",
      },
    });
    expect(createSignedUrl).toHaveBeenCalledWith("person-uploads", PERSON_PATH);
    expect(createSignedUrl).toHaveBeenCalledWith(
      "try-on-results",
      `${USER_ID}/${JOB_ID}.jpg`
    );
  });

  it("需要原圖但人物照已清除時維持既有 409 domain result", async () => {
    installSupabase({ ownedJob: makeJob({ person_image_url: null }) });
    installProvider({ requiresImagesOnPoll: true });

    const result = await getAndAdvanceTryOnWorkflow(input);

    expect(updateJobStatus).toHaveBeenCalledWith(JOB_ID, {
      status: "failed",
      error_message: "人物照已依資料保留政策清除。",
    });
    expect(result).toEqual({
      ok: false,
      code: "source_image_removed",
      message: "此試穿任務的原始照片已清除，無法繼續處理。",
    });
  });

  it("poll 直接拋例外時維持 throw，且不額外改變 Job", async () => {
    const provider = installProvider();
    provider.checkStatus.mockRejectedValue(new Error("poll network error"));

    await expect(getAndAdvanceTryOnWorkflow(input)).rejects.toThrow("poll network error");
    expect(updateJobStatus).not.toHaveBeenCalled();
  });
});
