import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import { createSignedUrl, getSupabaseAdmin } from "@/lib/supabase";
import { checkUploadQuota } from "@/lib/quota";
import { createUploadIntent } from "@/lib/upload-intent";
import { MAX_FILE_SIZE_BYTES } from "@/lib/upload-constraints";
import { GET, POST } from "./route";

vi.mock("@/lib/user", () => ({
  requireUser: vi.fn(),
}));

vi.mock("@/lib/supabase", () => ({
  PERSON_BUCKET: "person-uploads",
  getSupabaseAdmin: vi.fn(),
  createSignedUrl: vi.fn(),
}));

vi.mock("@/lib/quota", () => ({
  checkUploadQuota: vi.fn(),
}));

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";

function mockStorage(input?: { rawFile?: Blob }) {
  const createSignedUploadUrl = vi.fn().mockResolvedValue({
    data: { signedUrl: "https://project.supabase.co/storage/upload?token=signed" },
    error: null,
  });
  const download = vi.fn().mockResolvedValue({ data: input?.rawFile ?? null, error: null });
  const upload = vi.fn().mockResolvedValue({ error: null });
  const remove = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn().mockReturnValue({ createSignedUploadUrl, download, upload, remove });
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    storage: { from },
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, createSignedUploadUrl, download, upload, remove };
}

beforeEach(() => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-secret";
  vi.mocked(requireUser).mockResolvedValue({ id: USER_A } as never);
  vi.mocked(checkUploadQuota).mockResolvedValue({ allowed: true, usedToday: 0 });
  vi.mocked(createSignedUrl).mockResolvedValue("https://project.supabase.co/storage/signed/person.jpg");
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

describe("POST /api/upload prepare", () => {
  it("8MiB metadata 只簽 path，不接收圖片 body", async () => {
    const storage = mockStorage();
    const response = await POST(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare", mimeType: "image/jpeg", size: MAX_FILE_SIZE_BYTES }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.path).toMatch(new RegExp(`^${USER_A}/[0-9a-f-]{36}\\.upload$`, "i"));
    expect(body.signedUrl).toContain("supabase.co");
    expect(body.completionToken).toEqual(expect.any(String));
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(body.path, { upsert: false });
  });

  it("超過 8MiB 在簽發前拒絕", async () => {
    const storage = mockStorage();
    const response = await POST(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "prepare", mimeType: "image/png", size: MAX_FILE_SIZE_BYTES + 1 }),
    }));
    expect(response.status).toBe(422);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
});

describe("POST /api/upload complete", () => {
  it("實際 MIME/bytes 符合 intent 才建立正式 JPEG，並以 tombstone 鎖住 raw path", async () => {
    const jpeg = await sharp({
      create: { width: 640, height: 960, channels: 3, background: "#987" },
    }).jpeg().toBuffer();
    const rawFile = new Blob([Uint8Array.from(jpeg)], { type: "image/jpeg" });
    const storage = mockStorage({ rawFile });
    const { intent, token } = createUploadIntent({
      userId: USER_A,
      mimeType: rawFile.type,
      size: rawFile.size,
    });

    const response = await POST(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", path: intent.rawPath, completionToken: token }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.path).toBe(intent.finalPath);
    expect(body.previewUrl).toContain("supabase.co");
    expect(storage.download).toHaveBeenCalledWith(intent.rawPath);
    expect(storage.upload).toHaveBeenCalledWith(
      intent.finalPath,
      expect.any(Blob),
      { contentType: "image/jpeg", upsert: true }
    );
    expect(storage.upload).toHaveBeenCalledWith(
      intent.rawPath,
      expect.any(Blob),
      { contentType: "image/jpeg", upsert: true }
    );
  });

  it("他人的 token/path 無法下載或完成", async () => {
    const storage = mockStorage();
    const { intent, token } = createUploadIntent({
      userId: USER_B,
      mimeType: "image/jpeg",
      size: 1024,
    });
    const response = await POST(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", path: intent.rawPath, completionToken: token }),
    }));
    expect(response.status).toBe(403);
    expect(storage.download).not.toHaveBeenCalled();
  });

  it("實際 bytes 與 intent 不符時以 tombstone 鎖住 raw path 並拒絕", async () => {
    const rawFile = new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" });
    const storage = mockStorage({ rawFile });
    const { intent, token } = createUploadIntent({
      userId: USER_A,
      mimeType: "image/jpeg",
      size: rawFile.size + 1,
    });
    const response = await POST(new Request("http://localhost/api/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "complete", path: intent.rawPath, completionToken: token }),
    }));
    expect(response.status).toBe(422);
    expect(storage.upload).toHaveBeenCalledWith(
      intent.rawPath,
      expect.any(Blob),
      { contentType: "image/jpeg", upsert: true }
    );
    expect(storage.upload.mock.calls.some(([path]) => String(path).endsWith(".jpg"))).toBe(false);
  });
});

describe("GET /api/upload signed URL refresh", () => {
  it("只替本人正式 JPEG path 簽發直接 Storage URL", async () => {
    mockStorage();
    const path = `${USER_A}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;
    const response = await GET(new Request(`http://localhost/api/upload?path=${encodeURIComponent(path)}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ signedUrl: expect.stringContaining("supabase.co") });
    expect(createSignedUrl).toHaveBeenCalledWith("person-uploads", path);
  });

  it("他人 path 一律回 404 且不簽 URL", async () => {
    mockStorage();
    const path = `${USER_B}/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.jpg`;
    const response = await GET(new Request(`http://localhost/api/upload?path=${encodeURIComponent(path)}`));
    expect(response.status).toBe(404);
    expect(createSignedUrl).not.toHaveBeenCalled();
  });
});
