import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, isSupabaseAuthConfigured } from "@/lib/supabase/server";
import {
  AUTH_REQUIRED_MESSAGE,
  getCurrentUser,
  requireUser,
  userDisplayName,
  userLoginMethod,
} from "@/lib/user";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(),
  isSupabaseAuthConfigured: vi.fn(() => true),
}));

function mockAuthUser(user: Record<string, unknown> | null, error: unknown = null) {
  const getUser = vi.fn().mockResolvedValue({ data: { user }, error });
  vi.mocked(createClient).mockResolvedValue({ auth: { getUser } } as never);
  return getUser;
}

afterEach(() => vi.clearAllMocks());

describe("Supabase Auth 使用者", () => {
  it("以 Auth server getUser 重新驗證並回傳正式 user.id", async () => {
    const user = { id: "auth-user-id", email: "member@example.com", user_metadata: {} };
    const getUser = mockAuthUser(user);
    await expect(getCurrentUser()).resolves.toEqual(user);
    expect(getUser).toHaveBeenCalledOnce();
  });

  it("未登入時 requireUser 回 401 與可顯示的繁中訊息", async () => {
    mockAuthUser(null);
    await expect(requireUser()).rejects.toMatchObject({
      status: 401,
      message: AUTH_REQUIRED_MESSAGE,
    });
  });

  it("Auth 未設定時不建立 client", async () => {
    vi.mocked(isSupabaseAuthConfigured).mockReturnValue(false);
    await expect(getCurrentUser()).resolves.toBeNull();
    expect(createClient).not.toHaveBeenCalled();
  });

  it("顯示名稱優先使用 OAuth 名稱，否則使用 email 前綴", () => {
    expect(userDisplayName({ user_metadata: { full_name: "王小明" } } as never)).toBe("王小明");
    expect(userDisplayName({ email: "member@example.com", user_metadata: {} } as never)).toBe("member");
  });

  it("登入方式只顯示 Google 或 Email", () => {
    expect(userLoginMethod({ app_metadata: { provider: "google" } } as never)).toBe("Google");
    expect(userLoginMethod({ identities: [{ provider: "google" }] } as never)).toBe("Google");
    expect(userLoginMethod({ app_metadata: { provider: "email" } } as never)).toBe("Email");
  });
});
