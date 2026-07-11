// POST /api/upload — 上傳人物照片
// 流程：驗證檔案 → 轉正 + 壓縮成寬度 ≤1440 的 JPEG → 存進「私有」bucket →
// 回傳 Storage 路徑（給 /api/try-on 用）與「走自家網域」的預覽網址（/api/image，給前端預覽）。
import { NextResponse } from "next/server";
import { getOrCreateUserId } from "@/lib/user";
import { getSupabaseAdmin, PERSON_BUCKET, imageProxyUrl } from "@/lib/supabase";
import {
  MAX_FILE_SIZE_BYTES,
  validateFileMeta,
  normalizePersonImage,
  toJpegUploadBlob,
} from "@/lib/validation";
import { checkUploadQuota } from "@/lib/quota";
import { jsonError, errorMessage } from "@/lib/http";

export async function POST(req: Request) {
  try {
    // 正常的 4 MiB 檔案加上 multipart 邊界只會多出少量 bytes。
    // 若 Content-Length 明顯更大，先以既有 JSON 錯誤格式拒絕，避免進入 formData()。
    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_FILE_SIZE_BYTES + 64 * 1024) {
      return jsonError(413, "照片超過 4MB。圖片不得超過 4MB，請縮小後再上傳。");
    }

    const userId = await getOrCreateUserId();

    // 每日上傳上限（成本控管）：放在解析 formData 之前，
    // 超限的請求連檔案都不收進記憶體，更不會白耗 sharp CPU。
    const uploadQuota = await checkUploadQuota(userId);
    if (!uploadQuota.allowed) {
      return jsonError(429, uploadQuota.reason ?? "今天的照片上傳次數已用完，明天會自動恢復。");
    }

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonError(400, "沒有收到照片檔案，請重新選擇一張照片上傳。");
    }

    const metaCheck = validateFileMeta({ type: file.type, size: file.size });
    if (!metaCheck.ok) return jsonError(422, metaCheck.message);

    const normalized = await normalizePersonImage(Buffer.from(await file.arrayBuffer()));
    if (!normalized.ok) return jsonError(422, normalized.message);

    // 路徑以 userId 開頭，後端可藉此驗證「這張圖是這個使用者上傳的」
    const path = `${userId}/${crypto.randomUUID()}.jpg`;
    const supabase = getSupabaseAdmin();
    const uploadBody = toJpegUploadBlob(normalized.buffer);
    const { error } = await supabase.storage
      .from(PERSON_BUCKET)
      .upload(path, uploadBody, { contentType: "image/jpeg" });
    if (error) {
      return jsonError(500, `照片上傳失敗（${error.message}），請再試一次。`);
    }

    // 預覽走自家網域轉發（避免部分網路封鎖 supabase.co 導致破圖），實際權限在 /api/image 檢查
    const previewUrl = imageProxyUrl(PERSON_BUCKET, path);
    return NextResponse.json({ status: "success", path, previewUrl });
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
