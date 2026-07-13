import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  UPLOAD_COMPLETION_TTL_MS,
  createUploadIntent,
  isOwnedPersonImagePath,
  isOwnedRawUploadPath,
  rawUploadPathForPersonImage,
  verifyUploadIntent,
} from "@/lib/upload-intent";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-secret";
  vi.spyOn(crypto, "randomUUID").mockReturnValue("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("upload intent", () => {
  it("綁定使用者、raw/final path、MIME、bytes 與 10 分鐘效期", () => {
    const now = Date.parse("2026-07-12T00:00:00Z");
    const { intent, token } = createUploadIntent({
      userId: USER_A,
      mimeType: "image/png",
      size: 8 * 1024 * 1024,
      now,
    });
    expect(intent.rawPath).toBe(`${USER_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.upload`);
    expect(intent.finalPath).toBe(`${USER_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`);
    expect(intent.expiresAt).toBe(now + UPLOAD_COMPLETION_TTL_MS);
    expect(verifyUploadIntent(token, USER_A, intent.rawPath, now)).toEqual(intent);
  });

  it("他人使用者、竄改 path、竄改簽章與逾期 token 全部拒絕", () => {
    const now = Date.parse("2026-07-12T00:00:00Z");
    const { intent, token } = createUploadIntent({
      userId: USER_A,
      mimeType: "image/jpeg",
      size: 1024,
      now,
    });
    expect(verifyUploadIntent(token, USER_B, intent.rawPath, now)).toBeNull();
    expect(verifyUploadIntent(token, USER_A, `${USER_A}/other.upload`, now)).toBeNull();
    expect(verifyUploadIntent(`${token.slice(0, -1)}x`, USER_A, intent.rawPath, now)).toBeNull();
    expect(verifyUploadIntent(token, USER_A, intent.rawPath, now + UPLOAD_COMPLETION_TTL_MS + 1)).toBeNull();
  });

  it("路徑檢查只接受本人根目錄下的隨機 raw 或正式 JPEG", () => {
    const raw = `${USER_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.upload`;
    const final = `${USER_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;
    expect(isOwnedRawUploadPath(USER_A, raw)).toBe(true);
    expect(isOwnedPersonImagePath(USER_A, final)).toBe(true);
    expect(isOwnedRawUploadPath(USER_B, raw)).toBe(false);
    expect(isOwnedPersonImagePath(USER_A, `${USER_A}/../${USER_B}/photo.jpg`)).toBe(false);
    expect(rawUploadPathForPersonImage(final)).toBe(raw);
  });
});
