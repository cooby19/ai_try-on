import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import {
  getAndAdvanceTryOnWorkflow,
  startTryOnWorkflow,
} from "@/lib/try-on/workflow";
import type {
  GetAndAdvanceTryOnWorkflowResult,
  StartTryOnWorkflowResult,
} from "@/lib/try-on/workflow";
import { POST } from "./route";
import { GET } from "./[jobId]/route";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/try-on/workflow", () => ({
  getAndAdvanceTryOnWorkflow: vi.fn(),
  startTryOnWorkflow: vi.fn(),
}));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const PRODUCT_ID = "22222222-2222-4222-8222-222222222222";
const JOB_ID = "33333333-3333-4333-8333-333333333333";
const PERSON_PATH = `${USER_ID}/44444444-4444-4444-8444-444444444444.jpg`;

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ id: USER_ID } as never);
});

describe("POST /api/try-on Workflow 契約", () => {
  it("把 authenticated userId 與原始輸入交給 Workflow，成功 JSON 欄位不變", async () => {
    vi.mocked(startTryOnWorkflow).mockResolvedValue({
      ok: true,
      jobId: JOB_ID,
      status: "processing",
      costEstimate: 0.075,
      remainingToday: 2,
    });
    const response = await POST(
      new Request("https://example.com/api/try-on", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          productId: PRODUCT_ID,
          personImagePath: PERSON_PATH,
          model: "v1.6",
        }),
      })
    );

    expect(startTryOnWorkflow).toHaveBeenCalledWith({
      userId: USER_ID,
      productId: PRODUCT_ID,
      personImagePath: PERSON_PATH,
      requestedModel: "v1.6",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      jobId: JOB_ID,
      status: "processing",
      costEstimate: 0.075,
      remainingToday: 2,
    });
  });

  const failures: Array<{
    name: string;
    result: Exclude<StartTryOnWorkflowResult, { ok: true }>;
    status: number;
    body: Record<string, unknown>;
  }> = [
    {
      name: "缺少輸入",
      result: { ok: false, code: "missing_input", message: "缺少商品或人物照片資訊，請重新操作一次。" },
      status: 400,
      body: { status: "failed", message: "缺少商品或人物照片資訊，請重新操作一次。" },
    },
    {
      name: "model 不支援",
      result: { ok: false, code: "unsupported_model", message: "不支援的生成模型，請重新整理頁面後再選擇一次。" },
      status: 400,
      body: { status: "failed", message: "不支援的生成模型，請重新整理頁面後再選擇一次。" },
    },
    {
      name: "人物照不屬於本人",
      result: { ok: false, code: "invalid_person_image", message: "照片來源驗證失敗，請重新上傳照片。" },
      status: 403,
      body: { status: "failed", message: "照片來源驗證失敗，請重新上傳照片。" },
    },
    {
      name: "商品不存在",
      result: { ok: false, code: "product_not_found", message: "找不到這個商品，請重新整理頁面。" },
      status: 404,
      body: { status: "failed", message: "找不到這個商品，請重新整理頁面。" },
    },
    {
      name: "額度拒絕",
      result: { ok: false, code: "quota_rejected", message: "已達生成上限。", remainingToday: 0 },
      status: 429,
      body: { status: "failed", message: "已達生成上限。", remainingToday: 0 },
    },
    {
      name: "Provider 提交失敗",
      result: { ok: false, code: "submission_failed", message: "provider unavailable", jobId: JOB_ID },
      status: 502,
      body: { status: "failed", message: "provider unavailable", jobId: JOB_ID },
    },
  ];

  it.each(failures)("$name 維持 status、message 與 extra fields", async ({ result, status, body }) => {
    vi.mocked(startTryOnWorkflow).mockResolvedValue(result);
    const response = await POST(
      new Request("https://example.com/api/try-on", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: PRODUCT_ID, personImagePath: PERSON_PATH }),
      })
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual(body);
  });
});

describe("GET /api/try-on/[jobId] Workflow 契約", () => {
  it("把 authenticated userId 與 Promise params 交給 Workflow，成功 View 欄位不變", async () => {
    const view = {
      jobId: JOB_ID,
      status: "success" as const,
      personImageUrl: "https://storage.example/person-signed",
      resultImageUrl: "https://storage.example/result-signed",
      costEstimate: 0.08,
      retryCount: 1,
      message: "完成",
    };
    vi.mocked(getAndAdvanceTryOnWorkflow).mockResolvedValue({ ok: true, view });

    const response = await GET(
      new Request(`https://example.com/api/try-on/${JOB_ID}`),
      { params: Promise.resolve({ jobId: JOB_ID }) }
    );

    expect(getAndAdvanceTryOnWorkflow).toHaveBeenCalledWith({
      userId: USER_ID,
      jobId: JOB_ID,
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(view);
  });

  const failures: Array<{
    name: string;
    result: Exclude<GetAndAdvanceTryOnWorkflowResult, { ok: true }>;
    status: number;
  }> = [
    {
      name: "本人 Job 不存在",
      result: { ok: false, code: "job_not_found", message: "找不到這筆試穿紀錄。" },
      status: 404,
    },
    {
      name: "原始照片已清除",
      result: {
        ok: false,
        code: "source_image_removed",
        message: "此試穿任務的原始照片已清除，無法繼續處理。",
      },
      status: 409,
    },
  ];

  it.each(failures)("$name 維持既有 HTTP 錯誤", async ({ result, status }) => {
    vi.mocked(getAndAdvanceTryOnWorkflow).mockResolvedValue(result);
    const response = await GET(
      new Request(`https://example.com/api/try-on/${JOB_ID}`),
      { params: Promise.resolve({ jobId: JOB_ID }) }
    );

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ status: "failed", message: result.message });
  });

  it("未預期的 Workflow 例外仍由 HTTP 層映射為 500", async () => {
    vi.mocked(getAndAdvanceTryOnWorkflow).mockRejectedValue(new Error("poll network error"));

    const response = await GET(
      new Request(`https://example.com/api/try-on/${JOB_ID}`),
      { params: Promise.resolve({ jobId: JOB_ID }) }
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: "failed", message: "poll network error" });
  });
});
