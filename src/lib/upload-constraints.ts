// 前後端共用的上傳限制。這個檔案刻意不 import sharp 等 Node.js 套件，
// 讓 client component 能在送出 request 前使用完全相同的驗證規則。
export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
// 原始檔直接送 Supabase Storage，不再受 Vercel Function 4.5 MB request 上限影響。
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024;
export const TARGET_MAX_WIDTH = 1440;

export type ValidationResult =
  | { ok: true }
  | { ok: false; message: string };

export function validateFileMeta(file: { type: string; size: number }): ValidationResult {
  if (!ALLOWED_MIME_TYPES.includes(file.type)) {
    return {
      ok: false,
      message: "目前只支援 JPG、PNG 或 WebP 圖片。請把照片另存成這幾種格式後再上傳一次。",
    };
  }
  if (file.size > MAX_FILE_SIZE_BYTES) {
    return {
      ok: false,
      message: `照片超過 8MB。圖片不得超過 8MB，請換一張較小的照片，或先把照片稍微縮小（寬度 ${TARGET_MAX_WIDTH}px 以內即可）再上傳。`,
    };
  }
  if (!Number.isSafeInteger(file.size) || file.size <= 0) {
    return { ok: false, message: "上傳的檔案是空的，請重新選擇一張照片。" };
  }
  return { ok: true };
}
