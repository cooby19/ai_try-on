// POST /api/upload — 上傳人物照片
// 流程：驗證檔案 → 轉正 + 壓縮成寬度 ≤1024 的 JPEG → 存進「私有」bucket →
// 回傳 Storage 路徑（給 /api/try-on 用）與短期 signed URL（給前端預覽）。
import { NextResponse } from "next/server";
import { getOrCreateUserId } from "@/lib/user";
import { getSupabaseAdmin, PERSON_BUCKET, createSignedUrl } from "@/lib/supabase";
import { validateFileMeta, normalizePersonImage } from "@/lib/validation";
import { jsonError, errorMessage } from "@/lib/http";

export async function POST(req: Request) {
  try {
    const userId = await getOrCreateUserId();

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
    const { error } = await supabase.storage
      .from(PERSON_BUCKET)
      .upload(path, normalized.buffer, { contentType: "image/jpeg" });
    if (error) {
      return jsonError(500, `照片上傳失敗（${error.message}），請再試一次。`);
    }

    const previewUrl = await createSignedUrl(PERSON_BUCKET, path);
    return NextResponse.json({ status: "success", path, previewUrl });
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
