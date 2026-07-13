import { createHmac, timingSafeEqual } from "crypto";

// Supabase signed upload URL 固定約 2 小時有效，SDK 不提供自訂 TTL。
// 應用層把「完成驗證」憑證縮到 10 分鐘：超時後即使原始檔已傳上去，
// 也不能被轉成正式人物照或送進 AI 流程。
export const UPLOAD_COMPLETION_TTL_MS = 10 * 60 * 1000;

export interface UploadIntent {
  version: 1;
  userId: string;
  rawPath: string;
  finalPath: string;
  mimeType: string;
  size: number;
  expiresAt: number;
}

function signingSecret(): string {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!secret) throw new Error("尚未設定上傳授權簽章金鑰。");
  return secret;
}

function sign(payload: string): string {
  return createHmac("sha256", signingSecret()).update(payload).digest("base64url");
}

export function createUploadIntent(input: {
  userId: string;
  mimeType: string;
  size: number;
  now?: number;
}): { intent: UploadIntent; token: string } {
  const uploadId = crypto.randomUUID();
  const intent: UploadIntent = {
    version: 1,
    userId: input.userId,
    // 臨時檔不用原始副檔名，避免檔名被誤當成已驗證格式。
    rawPath: `${input.userId}/${uploadId}.upload`,
    finalPath: `${input.userId}/${uploadId}.jpg`,
    mimeType: input.mimeType,
    size: input.size,
    expiresAt: (input.now ?? Date.now()) + UPLOAD_COMPLETION_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(intent)).toString("base64url");
  return { intent, token: `${payload}.${sign(payload)}` };
}

export function verifyUploadIntent(
  token: string,
  expectedUserId: string,
  expectedRawPath: string,
  now = Date.now()
): UploadIntent | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = sign(payload);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    return null;
  }

  try {
    const intent = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as UploadIntent;
    if (
      intent.version !== 1 ||
      intent.userId !== expectedUserId ||
      intent.rawPath !== expectedRawPath ||
      intent.expiresAt < now ||
      !isOwnedRawUploadPath(expectedUserId, intent.rawPath) ||
      !isOwnedPersonImagePath(expectedUserId, intent.finalPath) ||
      typeof intent.mimeType !== "string" ||
      !Number.isSafeInteger(intent.size) ||
      intent.size <= 0
    ) {
      return null;
    }
    return intent;
  } catch {
    return null;
  }
}

export function isOwnedRawUploadPath(userId: string, path: string): boolean {
  const [owner, filename, extra] = path.split("/");
  return owner === userId && extra === undefined && /^[0-9a-f-]{36}\.upload$/i.test(filename ?? "");
}

export function isOwnedPersonImagePath(userId: string, path: string): boolean {
  const [owner, filename, extra] = path.split("/");
  return owner === userId && extra === undefined && /^[0-9a-f-]{36}\.jpg$/i.test(filename ?? "");
}

export function rawUploadPathForPersonImage(path: string): string | null {
  return path.endsWith(".jpg") ? `${path.slice(0, -4)}.upload` : null;
}
