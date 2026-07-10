// ensureUserRow 的回歸保護：upsert 失敗曾被無聲吞掉，造成「cookie 已發出、
// users 列卻不存在」的卡死狀態——上傳照片成功（Storage 不查 users 表），
// 但建立試穿任務因 try_on_jobs 的外鍵持續失敗，使用者只能自己清 cookie。
// 這裡釘死「失敗必須 throw、訊息是可操作的繁中文案、不透出原始 DB 錯誤」。
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase";
import { ensureUserRow } from "@/lib/user";

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
}));

// user.ts 頂層 import next/headers（給 cookie 相關函式用）；
// ensureUserRow 本身用不到，mock 掉讓測試在 node 環境離線執行。
vi.mock("next/headers", () => ({
  cookies: vi.fn(),
}));

// 模擬 from("users").upsert(...) 鏈，回傳 mock 以驗證 upsert 參數
function mockUsersUpsert(result: { error: { message: string } | null }) {
  const upsert = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ upsert });
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, upsert };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ensureUserRow", () => {
  it("upsert 成功：正常結束，且以 ignoreDuplicates 避免重複來訪報錯", async () => {
    const { from, upsert } = mockUsersUpsert({ error: null });
    await expect(ensureUserRow("user-1")).resolves.toBeUndefined();
    expect(from).toHaveBeenCalledWith("users");
    expect(upsert).toHaveBeenCalledWith(
      { id: "user-1" },
      { onConflict: "id", ignoreDuplicates: true }
    );
  });

  it("upsert 失敗：必須 throw（吞掉 = 使用者卡死到清 cookie），訊息為可操作繁中文案", async () => {
    mockUsersUpsert({ error: { message: "connection refused" } });
    await expect(ensureUserRow("user-1")).rejects.toThrow(/重新整理頁面/);
  });

  it("upsert 失敗：不透出原始 DB 錯誤（錯誤訊息慣例）", async () => {
    mockUsersUpsert({ error: { message: "connection refused" } });
    await expect(ensureUserRow("user-1")).rejects.not.toThrow(/connection refused/);
  });
});
