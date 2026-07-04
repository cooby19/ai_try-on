// 匿名使用者識別：MVP 不做登入，改用 cookie 中的匿名 ID 計算每日額度。
// users 表保留 email 欄位，未來要加登入時可以把匿名 ID 併入正式帳號。
import { cookies } from "next/headers";
import { getSupabaseAdmin } from "./supabase";

const COOKIE_NAME = "vto_uid";
const ONE_YEAR = 60 * 60 * 24 * 365;

// 只能在 Route Handler 內呼叫（Server Component 不能寫 cookie）。
// 回傳匿名使用者 ID；若是第一次來訪就發一個新的並寫入 cookie 與 users 表。
export async function getOrCreateUserId(): Promise<string> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME)?.value;
  if (existing && isUuid(existing)) {
    return existing;
  }
  const userId = crypto.randomUUID();
  cookieStore.set(COOKIE_NAME, userId, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: ONE_YEAR,
    path: "/",
  });
  await ensureUserRow(userId);
  return userId;
}

// 讀取現有匿名 ID（不建立新的），給 GET 類端點用
export async function getUserId(): Promise<string | null> {
  const cookieStore = await cookies();
  const existing = cookieStore.get(COOKIE_NAME)?.value;
  return existing && isUuid(existing) ? existing : null;
}

export async function ensureUserRow(userId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  await supabase.from("users").upsert({ id: userId }, { onConflict: "id", ignoreDuplicates: true });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
