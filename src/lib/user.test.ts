// 匿名 session 的安全邊界：cookie 只能放高熵 token、DB 只查 token 雜湊，
// 舊 vto_uid 不再授權；同一來源即使清 cookie，來源雜湊也必須維持一致。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  getOrCreateUserSession,
  getUserSession,
  hashSessionToken,
  sourceHashForRequest,
} from "@/lib/user";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/supabase", () => ({ getSupabaseAdmin: vi.fn() }));

function cookieStore(values: Record<string, string> = {}) {
  return {
    get: vi.fn((name: string) => (values[name] ? { name, value: values[name] } : undefined)),
    set: vi.fn(),
    has: vi.fn((name: string) => name in values),
    delete: vi.fn(),
  };
}

function mockSessionLookup(result: {
  data: { user_id: string; source_hash: string } | null;
  error: { message: string } | null;
}) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const gt = vi.fn().mockReturnValue({ maybeSingle });
  const is = vi.fn().mockReturnValue({ gt });
  const eq = vi.fn().mockReturnValue({ is });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, eq };
}

beforeEach(() => {
  vi.stubEnv("SESSION_HASH_SECRET", "test-secret-that-is-at-least-32-characters-long");
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("既有 session 驗證", () => {
  it("只有舊 vto_uid：不查 users、不接受 UUID 身分", async () => {
    const store = cookieStore({ vto_uid: "11111111-1111-1111-1111-111111111111" });
    vi.mocked(cookies).mockResolvedValue(store as never);
    await expect(getUserSession()).resolves.toBeNull();
    expect(getSupabaseAdmin).not.toHaveBeenCalled();
  });

  it("session token：只用 SHA-256 雜湊查 DB，再取回內部 user", async () => {
    const token = "secret-browser-token";
    vi.mocked(cookies).mockResolvedValue(cookieStore({ "__Host-vto_session": token }) as never);
    const { eq } = mockSessionLookup({
      data: { user_id: "user-a", source_hash: "source-a" },
      error: null,
    });
    await expect(getUserSession()).resolves.toEqual({ userId: "user-a", sourceHash: "source-a" });
    expect(eq).toHaveBeenCalledWith("token_hash", hashSessionToken(token));
    expect(eq).not.toHaveBeenCalledWith("token_hash", token);
  });
});

describe("建立匿名 session", () => {
  it("DB 成功後才發 Secure/HttpOnly cookie，並淘汰 vto_uid", async () => {
    const store = cookieStore({ vto_uid: "legacy-id" });
    vi.mocked(cookies).mockResolvedValue(store as never);
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: true, user_id: "new-user" }, error: null });
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc } as unknown as ReturnType<typeof getSupabaseAdmin>);

    const request = new Request("https://example.com/api/quota", {
      headers: { "x-forwarded-for": "203.0.113.10" },
    });
    const session = await getOrCreateUserSession(request);
    expect(session.userId).toBe("new-user");
    expect(session.sourceHash).toHaveLength(64);
    expect(store.set).toHaveBeenCalledWith(
      "__Host-vto_session",
      expect.not.stringMatching(/^[0-9a-f-]{36}$/i),
      expect.objectContaining({ httpOnly: true, secure: true, sameSite: "lax", path: "/" })
    );
    expect(store.delete).toHaveBeenCalledWith("vto_uid");
    const rpcArgs = rpc.mock.calls[0][1];
    expect(rpcArgs.p_token_hash).toHaveLength(64);
    expect(rpcArgs.p_token_hash).not.toBe(store.set.mock.calls[0][1]);
  });

  it("同一來源清 cookie 後重建 session，來源雜湊仍相同", () => {
    const first = new Request("https://example.com", { headers: { "x-forwarded-for": "203.0.113.10" } });
    const second = new Request("https://example.com", { headers: { "x-forwarded-for": "203.0.113.10" } });
    expect(sourceHashForRequest(first)).toBe(sourceHashForRequest(second));
  });

  it("同一來源建立過多匿名身分時回 429", async () => {
    vi.mocked(cookies).mockResolvedValue(cookieStore() as never);
    const rpc = vi.fn().mockResolvedValue({ data: { allowed: false }, error: null });
    vi.mocked(getSupabaseAdmin).mockReturnValue({ rpc } as unknown as ReturnType<typeof getSupabaseAdmin>);
    const error = await getOrCreateUserSession(
      new Request("https://example.com", { headers: { "x-forwarded-for": "203.0.113.10" } })
    ).catch((caught) => caught);
    expect(error).toMatchObject({ status: 429 });
  });
});
