// 匿名身分使用「高熵 session token → DB token 雜湊 → 內部 user」映射。
// user UUID 只是資料識別碼，永遠不再從 cookie 讀取或當成授權憑證。
import { createHash, createHmac, randomBytes } from "node:crypto";
import { cookies } from "next/headers";
import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";

const COOKIE_NAME = "__Host-vto_session";
const LEGACY_COOKIE_NAME = "vto_uid";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const MAX_NEW_SESSIONS_PER_SOURCE_PER_DAY = 5;

export interface AnonymousSession {
  userId: string;
  sourceHash: string;
}

type SessionRow = { user_id: string; source_hash: string };
type SessionCreationResult = { allowed: boolean; user_id?: string };

function sessionSecret(): string {
  const secret = process.env.SESSION_HASH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("尚未設定 SESSION_HASH_SECRET，或長度不足 32 個字元。請先完成安全環境變數設定。");
  }
  return secret;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// IP 只用不可逆 HMAC 保存，不把原始網路位址寫進資料庫。
// 反向代理必須覆寫 CLIENT_IP_HEADER，否則攻擊者可能偽造來源標頭。
export function sourceHashForRequest(request: Request): string {
  const headerName = (process.env.CLIENT_IP_HEADER || "x-forwarded-for").toLowerCase();
  const raw = request.headers.get(headerName) ?? request.headers.get("x-real-ip") ?? "unknown";
  const ip = raw.split(",", 1)[0]?.trim() || "unknown";
  return createHmac("sha256", sessionSecret()).update(`ip:${ip}`).digest("hex");
}

async function lookupSession(token: string): Promise<AnonymousSession | null> {
  // 256-bit token 不可預測，DB 只存 SHA-256；資料庫外洩不會直接產生可用 cookie。
  const tokenHash = hashSessionToken(token);
  const { data, error } = await getSupabaseAdmin()
    .from("anonymous_sessions")
    .select("user_id, source_hash")
    .eq("token_hash", tokenHash)
    .is("revoked_at", null)
    .gt("expires_at", new Date().toISOString())
    .maybeSingle<SessionRow>();
  if (error) throw new Error("匿名工作階段驗證失敗，請稍後再試。");
  return data ? { userId: data.user_id, sourceHash: data.source_hash } : null;
}

// 讀取既有可信 session；無效、過期、撤銷或舊 vto_uid 都不會被接受。
export async function getUserSession(): Promise<AnonymousSession | null> {
  const token = (await cookies()).get(COOKIE_NAME)?.value;
  return token ? lookupSession(token) : null;
}

// 只能在 Route Handler 呼叫：DB 原子建立 user + session 成功後才發 cookie。
export async function getOrCreateUserSession(request: Request): Promise<AnonymousSession> {
  const existing = await getUserSession();
  if (existing) return existing;

  const token = randomBytes(32).toString("base64url");
  const sourceHash = sourceHashForRequest(request);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  const { data, error } = await getSupabaseAdmin().rpc("create_anonymous_session", {
    p_token_hash: hashSessionToken(token),
    p_source_hash: sourceHash,
    p_expires_at: expiresAt,
    p_since: todayStartUtcIso(),
    p_creation_limit: MAX_NEW_SESSIONS_PER_SOURCE_PER_DAY,
  });
  if (error) throw new Error("建立匿名工作階段失敗，請稍後再試。");

  const result = data as SessionCreationResult | null;
  if (!result || typeof result.allowed !== "boolean") {
    throw new Error("建立匿名工作階段失敗：資料庫函式回傳格式異常，請確認 migration 004 已執行。");
  }
  if (!result.allowed) {
    throw new AppError(429, "此網路今天建立了過多匿名工作階段，請明天再試或登入正式帳號。");
  }
  if (!result.user_id) throw new Error("建立匿名工作階段失敗：未取得使用者資料。");

  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
    priority: "high",
  });
  // 明確淘汰可偽造的舊 cookie；後端從此完全不讀取它。
  if (cookieStore.has(LEGACY_COOKIE_NAME)) cookieStore.delete(LEGACY_COOKIE_NAME);
  return { userId: result.user_id, sourceHash };
}

// 與額度模組同樣以台北午夜為每日邊界；留在本檔避免 auth ↔ quota 循環依賴。
function todayStartUtcIso(): string {
  const now = new Date();
  const taipeiNow = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  taipeiNow.setUTCHours(0, 0, 0, 0);
  return new Date(taipeiNow.getTime() - 8 * 60 * 60 * 1000).toISOString();
}
