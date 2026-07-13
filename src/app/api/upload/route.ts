// POST /api/upload
//   prepare：只接收 JSON metadata，簽發 Supabase 直傳 URL（大圖不進 Vercel body）。
//   complete：從私有 Storage 下載剛直傳的原始檔，驗證／正規化後存成正式 JPEG。
// GET /api/upload?path=...：替目前使用者的正式人物照刷新 1 小時 signed display URL。
import { NextResponse } from "next/server";
import { getOrCreateUserSession, getUserSession } from "@/lib/user";
import { createSignedUrl, getSupabaseAdmin, PERSON_BUCKET } from "@/lib/supabase";
import { normalizePersonImage, toJpegUploadBlob, validateFileMeta } from "@/lib/validation";
import { checkUploadQuota } from "@/lib/quota";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import {
  createUploadIntent,
  isOwnedPersonImagePath,
  verifyUploadIntent,
} from "@/lib/upload-intent";

type PrepareBody = {
  action: "prepare";
  mimeType?: unknown;
  size?: unknown;
};

type CompleteBody = {
  action: "complete";
  path?: unknown;
  completionToken?: unknown;
};

// terminal 狀態以極小 tombstone 覆寫 raw object，而不是刪除：signed upload URL 是 path token，
// 若把 object 刪掉，同一 URL 在官方 2 小時效期內可能再次寫入。保留 path 可鎖死重放。
async function lockRawUpload(path: string): Promise<void> {
  const tombstone = new Blob([new Uint8Array([0])], { type: "image/jpeg" });
  const { error } = await getSupabaseAdmin().storage.from(PERSON_BUCKET).upload(path, tombstone, {
    contentType: "image/jpeg",
    upsert: true,
  });
  if (error) console.error(`鎖定已使用的上傳 path 失敗（${path}）：`, error.message);
}

export async function POST(req: Request) {
  try {
    const { userId } = await getOrCreateUserSession(req);
    const body = (await req.json().catch(() => null)) as PrepareBody | CompleteBody | null;
    if (!body || (body.action !== "prepare" && body.action !== "complete")) {
      return jsonError(400, "上傳請求格式不正確，請重新選擇照片。");
    }

    if (body.action === "prepare") {
      const metaCheck = validateFileMeta({
        type: typeof body.mimeType === "string" ? body.mimeType : "",
        size: typeof body.size === "number" ? body.size : Number.NaN,
      });
      if (!metaCheck.ok) return jsonError(422, metaCheck.message);

      const quota = await checkUploadQuota(userId);
      if (!quota.allowed) {
        return jsonError(429, quota.reason ?? "今天的照片上傳次數已用完，明天會自動恢復。");
      }

      const { intent, token } = createUploadIntent({
        userId,
        mimeType: body.mimeType as string,
        size: body.size as number,
      });
      // upsert=false 讓 path 一旦成功寫入就不能用同一 signed URL 覆寫，形成一次性授權。
      const { data, error } = await getSupabaseAdmin().storage
        .from(PERSON_BUCKET)
        .createSignedUploadUrl(intent.rawPath, { upsert: false });
      if (error || !data) {
        return jsonError(500, `建立照片上傳授權失敗${error ? `（${error.message}）` : ""}，請再試一次。`);
      }
      return NextResponse.json({
        status: "success",
        path: intent.rawPath,
        signedUrl: data.signedUrl,
        completionToken: token,
        completionExpiresAt: intent.expiresAt,
      });
    }

    const rawPath = typeof body.path === "string" ? body.path : "";
    const completionToken = typeof body.completionToken === "string" ? body.completionToken : "";
    const intent = verifyUploadIntent(completionToken, userId, rawPath);
    if (!intent) {
      return jsonError(403, "照片上傳授權無效或已逾時，請重新選擇照片。");
    }

    // prepare 後可能有其他分頁完成上傳；正式寫檔前再查一次，超限就鎖住本次 raw path。
    const quota = await checkUploadQuota(userId);
    if (!quota.allowed) {
      await lockRawUpload(intent.rawPath);
      return jsonError(429, quota.reason ?? "今天的照片上傳次數已用完，明天會自動恢復。");
    }

    const supabase = getSupabaseAdmin();
    const { data: rawFile, error: downloadError } = await supabase.storage
      .from(PERSON_BUCKET)
      .download(intent.rawPath);
    if (downloadError || !rawFile) {
      return jsonError(422, "找不到剛上傳的照片，請重新選擇照片再試一次。");
    }

    // signed upload token 會綁 path，但無法綁精確 MIME/bytes；完成階段用 HMAC intent 補驗。
    if (rawFile.size !== intent.size || rawFile.type !== intent.mimeType) {
      await lockRawUpload(intent.rawPath);
      return jsonError(422, "上傳的照片內容與授權資訊不一致，請重新選擇照片。");
    }
    const actualMeta = validateFileMeta({ type: rawFile.type, size: rawFile.size });
    if (!actualMeta.ok) {
      await lockRawUpload(intent.rawPath);
      return jsonError(422, actualMeta.message);
    }

    const normalized = await normalizePersonImage(Buffer.from(await rawFile.arrayBuffer()));
    if (!normalized.ok) {
      await lockRawUpload(intent.rawPath);
      return jsonError(422, normalized.message);
    }

    const { error: uploadError } = await supabase.storage.from(PERSON_BUCKET).upload(
      intent.finalPath,
      toJpegUploadBlob(normalized.buffer),
      { contentType: "image/jpeg", upsert: true }
    );
    if (uploadError) {
      return jsonError(500, `照片處理後儲存失敗（${uploadError.message}），請再試一次。`);
    }

    const previewUrl = await createSignedUrl(PERSON_BUCKET, intent.finalPath);
    if (!previewUrl) {
      return jsonError(500, "照片已處理完成，但建立預覽連結失敗，請再試一次。");
    }
    await lockRawUpload(intent.rawPath);
    return NextResponse.json({ status: "success", path: intent.finalPath, previewUrl });
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}

export async function GET(req: Request) {
  try {
    const session = await getUserSession();
    if (!session) return jsonError(401, "請重新整理頁面以建立安全工作階段。");
    const { userId } = session;
    const path = new URL(req.url).searchParams.get("path") ?? "";
    if (!userId || !isOwnedPersonImagePath(userId, path)) {
      return jsonError(404, "找不到圖片。");
    }
    const signedUrl = await createSignedUrl(PERSON_BUCKET, path);
    if (!signedUrl) return jsonError(404, "找不到圖片。");
    return NextResponse.json({ status: "success", signedUrl });
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
