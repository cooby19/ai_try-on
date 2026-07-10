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

// 產生「走自家網域」的私有圖片網址（/api/image/...），取代直接對外的 supabase.co signed URL。
// 為什麼：有些網路（飯店 / 公司 / 部分地區）會封鎖 supabase.co，瀏覽器直連拿不到圖（破圖）。
// 改讓瀏覽器只連本站、由後端去 Supabase 取圖回傳，可繞過這類封鎖。
//
// 授權方式：把「簽章 + 效期」直接放進網址（?exp&sig），網址本身即為存取憑證——與原本
// Supabase signed URL 同樣的「限時能力」模型，但改在自家網域。刻意不用 cookie 驗證：
// 部分瀏覽器（Safari ITP / 隱私模式 / 擴充功能）不會把 cookie 帶進 <img> 請求，導致破圖。
// imageProxyUrl 只會在後端替「使用者本人擁有的路徑」簽發（上傳→自己的路徑；輪詢→loadOwnedJob
// 過濾過的自己的 job），所以憑證只會發給有權限的人。
const IMAGE_URL_TTL_MS = 60 * 60 * 1000; // 1 小時，比照原本 signed URL 效期

// 用 service role key 當 HMAC 秘鑰（僅後端可得、絕不外流；HMAC 不會反推出金鑰）。
// 簽章涵蓋 bucket / path / exp，任一被竄改都會驗不過。
function imageSignature(bucket: string, storagePath: string, exp: number): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  return createHmac("sha256", secret).update(`${bucket}\n${storagePath}\n${exp}`).digest("hex");
}

export function imageProxyUrl(bucket: string, storagePath: string): string {
  const exp = Date.now() + IMAGE_URL_TTL_MS;
  const sig = imageSignature(bucket, storagePath, exp);
  // storagePath 形如 {userId}/{uuid}.jpg；逐段編碼避免特殊字元破壞路由（route 端會自動解碼）
  const encoded = storagePath.split("/").map(encodeURIComponent).join("/");
  return `/api/image/${bucket}/${encoded}?exp=${exp}&sig=${sig}`;
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
