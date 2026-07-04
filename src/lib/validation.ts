// 上傳照片的基礎檢查（規格書第八節）。
// 第一版不做複雜的電腦視覺判斷（例如偵測是否多人、是否遮擋），
// 只做格式 / 大小 / 可解碼 / 尺寸檢查，並回傳「可操作」的錯誤訊息。
import sharp from "sharp";

export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB
export const MIN_IMAGE_WIDTH = 320; // 太小的圖生成品質會很差
export const TARGET_MAX_WIDTH = 1024; // 規格書建議壓縮到 768~1024px

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
      message: "照片超過 8MB。建議先用手機或電腦把照片縮小（寬度 768～1024px 就足夠）再上傳。",
    };
  }
  if (file.size === 0) {
    return { ok: false, message: "上傳的檔案是空的，請重新選擇一張照片。" };
  }
  return { ok: true };
}

// 確認圖片真的可以解碼，並統一轉成寬度最多 1024px 的 JPEG。
// 回傳處理後的 buffer；失敗時回傳可操作的錯誤訊息。
export async function normalizePersonImage(
  input: Buffer
): Promise<{ ok: true; buffer: Buffer } | { ok: false; message: string }> {
  try {
    const image = sharp(input, { failOn: "error" }).rotate(); // rotate()：依 EXIF 自動轉正
    const meta = await image.metadata();
    if (!meta.width || meta.width < MIN_IMAGE_WIDTH) {
      return {
        ok: false,
        message: `這張照片解析度太低（寬度需至少 ${MIN_IMAGE_WIDTH}px），試穿效果會不清楚。請改用解析度較高的正面半身照。`,
      };
    }
    const buffer = await image
      .resize({ width: TARGET_MAX_WIDTH, withoutEnlargement: true })
      .jpeg({ quality: 88 })
      .toBuffer();
    return { ok: true, buffer };
  } catch {
    return {
      ok: false,
      message: "這個檔案無法辨識為圖片，可能已損壞。請重新拍一張或改用另一張 JPG / PNG 照片。",
    };
  }
}
