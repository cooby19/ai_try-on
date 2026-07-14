// Route 層授權回歸：知道 job UUID 不等於有權限。GET / DELETE 都必須先取得可信 session，
// 並把 session 的內部 user_id 放進 DB 查詢；不能只用 jobId 查到資料後再相信前端。
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import { getSupabaseAdmin } from "@/lib/supabase";
import { AppError } from "@/lib/http";
import { DELETE, GET } from "@/app/api/try-on/[jobId]/route";
import type { TryOnJob } from "@/lib/types";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  PERSON_BUCKET: "person-uploads",
  RESULT_BUCKET: "try-on-results",
  createSignedUrl: vi.fn(),
}));

function mockOwnedJobLookup() {
  const single = vi.fn().mockResolvedValue({ data: null, error: null });
  const eqUser = vi.fn().mockReturnValue({ single });
  const eqJob = vi.fn().mockReturnValue({ eq: eqUser });
  const select = vi.fn().mockReturnValue({ eq: eqJob });
  const from = vi.fn().mockReturnValue({ select });
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, eqJob, eqUser };
}

function mockPhotoDeletion(input?: { storageErrorPath?: string; referenceCount?: number }) {
  const job: TryOnJob = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    user_id: "current-user-id",
    source_hash: null,
    product_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    person_image_url: "current-user-id/cccccccc-cccc-4ccc-8ccc-cccccccccccc.jpg",
    garment_image_url: "/garments/white-tee.svg",
    result_image_url: "current-user-id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg",
    provider: "mock",
    provider_job_id: "provider-job-id",
    status: "processing",
    cost_estimate: 0,
    budget_reservation: 0,
    retry_count: 0,
    error_message: null,
    created_at: "2026-07-13T01:00:00.000Z",
    updated_at: "2026-07-13T01:00:00.000Z",
  };

  const single = vi.fn().mockResolvedValue({ data: job, error: null });
  const ownedEqUser = vi.fn().mockReturnValue({ single });
  const ownedEqJob = vi.fn().mockReturnValue({ eq: ownedEqUser });

  const neq = vi.fn().mockResolvedValue({ count: input?.referenceCount ?? 0, error: null });
  const referenceEq = vi.fn().mockReturnValue({ neq });
  const select = vi.fn((columns: string) =>
    columns === "*" ? { eq: ownedEqJob } : { eq: referenceEq }
  );

  const updateEqUser = vi.fn().mockResolvedValue({ error: null });
  const updateEqJob = vi.fn().mockReturnValue({ eq: updateEqUser });
  const update = vi.fn().mockReturnValue({ eq: updateEqJob });
  const from = vi.fn().mockReturnValue({ select, update });

  const remove = vi.fn((paths: string[]) =>
    Promise.resolve({
      error: paths[0] === input?.storageErrorPath ? { message: "storage unavailable" } : null,
    })
  );
  const storageFrom = vi.fn().mockReturnValue({ remove });
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from,
    storage: { from: storageFrom },
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { job, from, update, updateEqUser, remove, storageFrom };
}

const params = { params: Promise.resolve({ jobId: "known-victim-job-id" }) };

afterEach(() => {
  vi.clearAllMocks();
});

describe("job API 所有權", () => {
  it.each([
    ["GET", GET],
    ["DELETE", DELETE],
  ])("%s：沒有可信 session 時回 401，且完全不查 job", async (_method, handler) => {
    vi.mocked(requireUser).mockRejectedValue(new AppError(401, "請先登入後再使用 AI 試穿功能。"));
    const response = await handler(new Request("https://example.com/api/try-on/known-victim-job-id"), params);
    expect(response.status).toBe(401);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", GET],
    ["DELETE", DELETE],
  ])("%s：知道 job UUID 仍強制用目前 session user_id 過濾", async (_method, handler) => {
    vi.mocked(requireUser).mockResolvedValue({ id: "attacker-auth-user-id" } as never);
    const { eqJob, eqUser } = mockOwnedJobLookup();
    const response = await handler(new Request("https://example.com/api/try-on/known-victim-job-id"), params);
    expect(response.status).toBe(404);
    expect(eqJob).toHaveBeenCalledWith("id", "known-victim-job-id");
    expect(eqUser).toHaveBeenCalledWith("user_id", "attacker-auth-user-id");
  });
});

describe("DELETE /api/try-on/[jobId] 照片刪除", () => {
  it("逐一刪除結果照、未共用人物照與上傳鎖，只更新並保留 job 列", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "current-user-id" } as never);
    const database = mockPhotoDeletion();
    const response = await DELETE(
      new Request(`https://example.com/api/try-on/${database.job.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ jobId: database.job.id }) }
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ status: "success", jobStatus: "failed" });
    expect(database.remove).toHaveBeenCalledWith([database.job.result_image_url]);
    expect(database.remove).toHaveBeenCalledWith([database.job.person_image_url]);
    expect(database.remove).toHaveBeenCalledWith([
      "current-user-id/cccccccc-cccc-4ccc-8ccc-cccccccccccc.upload",
    ]);
    expect(database.update).toHaveBeenCalledWith(expect.objectContaining({
      person_image_url: "",
      result_image_url: null,
      status: "failed",
      provider_job_id: null,
    }));
    expect(database.updateEqUser).toHaveBeenCalledWith("user_id", "current-user-id");
  });

  it("Storage 刪除失敗時不清除 DB 圖片欄位", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: "current-user-id" } as never);
    const resultPath = "current-user-id/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg";
    const database = mockPhotoDeletion({ storageErrorPath: resultPath });
    const response = await DELETE(
      new Request(`https://example.com/api/try-on/${database.job.id}`, { method: "DELETE" }),
      { params: Promise.resolve({ jobId: database.job.id }) }
    );

    expect(response.status).toBe(500);
    expect(database.update).not.toHaveBeenCalled();
  });
});
