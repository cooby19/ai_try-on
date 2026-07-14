import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireUser } from "@/lib/user";
import { POST } from "./route";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: vi.fn() }));

const CURRENT_USER = "11111111-1111-4111-8111-111111111111";
const VICTIM_USER = "22222222-2222-4222-8222-222222222222";
const pendingRow = {
  id: "33333333-3333-4333-8333-333333333333",
  requested_at: "2026-07-13T02:00:00.000Z",
  status: "pending",
  reason: null,
};

function request(body: Record<string, unknown>) {
  return new Request("https://shop.test/api/account/deletion-request", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function mockDatabase(input?: { existing?: typeof pendingRow | null }) {
  const maybeSingle = vi.fn().mockResolvedValue({
    data: input?.existing ?? null,
    error: null,
  });
  const limit = vi.fn().mockReturnValue({ maybeSingle });
  const order = vi.fn().mockReturnValue({ limit });
  const eqStatus = vi.fn().mockReturnValue({ order });
  const eqUser = vi.fn().mockReturnValue({ eq: eqStatus });
  const selectExisting = vi.fn().mockReturnValue({ eq: eqUser });

  const single = vi.fn().mockResolvedValue({ data: pendingRow, error: null });
  const selectInserted = vi.fn().mockReturnValue({ single });
  const insert = vi.fn().mockReturnValue({ select: selectInserted });
  const from = vi.fn().mockReturnValue({ select: selectExisting, insert });
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, eqUser, insert, maybeSingle };
}

afterEach(() => vi.clearAllMocks());

describe("POST /api/account/deletion-request", () => {
  it("沒有可信 session 時回 401，且不接觸資料庫", async () => {
    vi.mocked(requireUser).mockRejectedValue(new AppError(401, "請先登入。"));
    const response = await POST(request({}));
    expect(response.status).toBe(401);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it("只用目前 session user.id 建立申請，不相信 body 內的 userId", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: CURRENT_USER } as never);
    const database = mockDatabase();
    const response = await POST(request({ userId: VICTIM_USER, reason: "  不再使用  " }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.request).toMatchObject({ id: pendingRow.id, status: "pending" });
    expect(database.eqUser).toHaveBeenCalledWith("user_id", CURRENT_USER);
    expect(database.insert).toHaveBeenCalledWith({
      user_id: CURRENT_USER,
      reason: "不再使用",
      status: "pending",
    });
    expect(database.insert).not.toHaveBeenCalledWith(expect.objectContaining({ user_id: VICTIM_USER }));
  });

  it("已有 pending 申請時回既有資料並停用重複建立", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: CURRENT_USER } as never);
    const database = mockDatabase({ existing: pendingRow });
    const response = await POST(request({ reason: "再次申請" }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ alreadyPending: true, request: { id: pendingRow.id } });
    expect(database.insert).not.toHaveBeenCalled();
  });

  it("過長原因在寫入前回 422", async () => {
    vi.mocked(requireUser).mockResolvedValue({ id: CURRENT_USER } as never);
    const response = await POST(request({ reason: "x".repeat(1001) }));
    expect(response.status).toBe(422);
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });
});
