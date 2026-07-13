import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadFileToSignedUrl } from "@/lib/direct-upload";

afterEach(() => vi.restoreAllMocks());

describe("uploadFileToSignedUrl", () => {
  it("以 PUT 直接把 File 傳到 Supabase signed URL，不呼叫本站 API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));
    const file = new File([new Uint8Array([1, 2, 3])], "person.jpg", { type: "image/jpeg" });
    await uploadFileToSignedUrl("https://project.supabase.co/storage/upload?token=short", file);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("project.supabase.co");
    expect(init?.method).toBe("PUT");
    expect(init?.headers).toEqual({ "x-upsert": "false" });
    expect(init?.body).toBeInstanceOf(FormData);
  });

  it("Storage 拒絕時回傳可識別的錯誤", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 413 }));
    const file = new File([new Uint8Array([1])], "large.jpg", { type: "image/jpeg" });
    await expect(uploadFileToSignedUrl("https://project.supabase.co/upload", file)).rejects.toThrow("413");
  });
});
