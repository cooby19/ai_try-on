// Supabase 後端專用 client。
// 重要：這裡使用 service role key，「只能」在伺服器端（API route / server component）import，
// 絕對不可以在任何 "use client" 元件中使用，否則金鑰會被打包進前端。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

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

// 產生「走自家網域」的私有圖片網址（/api/image/...），取代直接對外的 supabase.co signed URL。
// 為什麼：有些網路（飯店 / 公司 / 部分地區）會封鎖 supabase.co，瀏覽器直連拿不到圖（破圖）。
// 改讓瀏覽器只連本站、由後端去 Supabase 取圖回傳，可繞過這類封鎖；權限檢查改在 /api/image 內做
// （見 src/app/api/image/[...slug]/route.ts）。回傳的是相對路徑，前端當作同源網址使用。
export function imageProxyUrl(bucket: string, storagePath: string): string {
  // storagePath 形如 {userId}/{uuid}.jpg；逐段編碼避免特殊字元破壞路由（route 端會自動解碼）
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  return `/api/image/${bucket}/${encoded}`;
}
