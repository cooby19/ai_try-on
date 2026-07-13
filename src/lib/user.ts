import "server-only";

import type { User } from "@supabase/supabase-js";
import { AppError } from "./http";
import { createClient, isSupabaseAuthConfigured } from "./supabase/server";

export const AUTH_REQUIRED_MESSAGE = "請先登入後再使用 AI 試穿功能。";

// 伺服器端一律向 Supabase Auth 重新驗證使用者，不信任 cookie 內未驗證的 session user。
export async function getCurrentUser(): Promise<User | null> {
  if (!isSupabaseAuthConfigured()) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  return data.user;
}

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) throw new AppError(401, AUTH_REQUIRED_MESSAGE);
  return user;
}

export function userDisplayName(user: User): string {
  const metadataName = user.user_metadata?.full_name ?? user.user_metadata?.name;
  if (typeof metadataName === "string" && metadataName.trim()) return metadataName.trim();
  return user.email?.split("@", 1)[0] || "會員";
}
