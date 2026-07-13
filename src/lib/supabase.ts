// Supabase 後端專用 client。
// 重要：這裡使用 service role key，「只能」在伺服器端（API route / server component）import，
// 絕對不可以在任何 "use client" 元件中使用，否則金鑰會被打包進前端。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHmac, timingSafeEqual } from "crypto";

let cached: SupabaseClient | null = null;

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

export function getSupabaseAdmin(): SupabaseClient {
  if (!isSupabaseConfigured()) {
    throw new Error(
      "尚未設定 Supabase：請複製 .env.local.example 為 .env.local，填入 SUPABASE_URL 與 SUPABASE_SERVICE_ROLE_KEY。"
    );
  }
  if (!cached) {
    cached = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false },
    });
  }
  return cached;
}

// 私有 bucket 名稱
export const PERSON_BUCKET = "person-uploads";
export const RESULT_BUCKET = "try-on-results";

// 簽發短期 signed URL（隱私需求：人物照與結果圖不公開，網址 1 小時後失效）
export async function createSignedUrl(bucket: string, path: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data.signedUrl;
}

// 舊版 /api/image fallback 的驗證器。新版不再產生這類 URL；只保留驗證，讓部署前
// 已開啟頁面中的 1 小時舊連結自然失效，不必在切版瞬間破圖。
function imageSignature(bucket: string, storagePath: string, exp: number): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createHmac("sha256", secret).update(`${bucket}\n${storagePath}\n${exp}`).digest("hex");
}

// /api/image 端驗證：效期未過且簽章相符才放行。用 timingSafeEqual 做定值時間比較防時序攻擊。
export function verifyImageSignature(
  bucket: string,
  storagePath: string,
  exp: number,
  sig: string
): boolean {
  if (!Number.isFinite(exp) || exp < Date.now()) return false; // 逾期
  const expected = imageSignature(bucket, storagePath, exp);
  if (sig.length !== expected.length) return false; // 長度不同時 timingSafeEqual 會丟例外
  return timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}
