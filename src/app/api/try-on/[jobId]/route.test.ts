// Route 層授權回歸：知道 job UUID 不等於有權限。GET / DELETE 都必須先取得可信 session，
// 並把 session 的內部 user_id 放進 DB 查詢；不能只用 jobId 查到資料後再相信前端。
import { afterEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import { getSupabaseAdmin } from "@/lib/supabase";
import { AppError } from "@/lib/http";
import { DELETE, GET } from "@/app/api/try-on/[jobId]/route";

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
