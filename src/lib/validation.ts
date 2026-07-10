// 上傳照片的基礎檢查（規格書第八節）。
// 第一版不做複雜的電腦視覺判斷（例如偵測是否多人、是否遮擋），
// 只做格式 / 大小 / 可解碼 / 尺寸檢查，並回傳「可操作」的錯誤訊息。
import sharp from "sharp";

export const ALLOWED_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_FILE_SIZE_BYTES = 8 * 1024 * 1024; // 8MB
export const MIN_IMAGE_WIDTH = 320; // 太小的圖生成品質會很差
// 上傳壓縮是整條品質管線的第一關：FASHN tryon-v1.6 的輸出不會超過輸入解析度
// （上限 864×1296），舊值 1024（規格書建議 768~1024px）在非 3:4 比例的照片上
// 高度常低於 1296，會逼 v1.6 降解析度輸出。1440 讓 3:4 直幅照高約 1920，
// 穩定覆蓋 1296 並留裁切餘裕；FASHN 官方前處理指南建議 1K 端點最長邊 ≤2000px，
// 1920 在範圍內（https://docs.fashn.ai/guides/image-preprocessing-best-practices）。
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
      message: "照片超過 8MB。請換一張較小的照片，或先把照片稍微縮小（寬度 1440px 以內即可）再上傳。",
    };
  }
  if (file.size === 0) {
    return { ok: false, message: "上傳的檔案是空的，請重新選擇一張照片。" };
  }
  return { ok: true };
}

// 確認圖片真的可以解碼，並統一轉成寬度最多 TARGET_MAX_WIDTH 的 JPEG。
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
      // q88 會先吃掉膚質／髮絲／布料紋理等高頻細節，成為 VTO 輸入品質的瓶頸；
      // q92 保留細節、檔案增幅可控（官方指南建議 q≈95，92 是與流量的折衷）。
      // 維持 JPEG 不改 PNG：照片存 PNG 體積暴增 5~10 倍，且存檔路徑與 contentType 都綁 JPEG。
      .jpeg({ quality: 92 })
      .toBuffer();
    return { ok: true, buffer };
  } catch {
    return {
      ok: false,
      message: "這個檔案無法辨識為圖片，可能已損壞。請重新拍一張或改用另一張 JPG / PNG 照片。",
    };
  }
}

// Supabase Storage 雖接受 Node Buffer，但 Next.js/Vercel 的 server fetch 路徑可能把它當文字處理，
// 將 JPEG 的 0xff 等非 UTF-8 位元改寫成 replacement character（ef bf bd）。人物照與生成結果
// 上傳前都明確轉成 Blob，讓 storage-js 使用二進位分支，避免任何文字轉碼。
export function toJpegUploadBlob(buffer: Buffer): Blob {
  const bytes = Uint8Array.from(buffer);
  return new Blob([bytes], { type: "image/jpeg" });
}
