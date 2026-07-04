// fashn.ts 的回歸保護：重點是錯誤轉譯（mapFashnError）——
// 規格要求使用者永遠看到「可操作的繁中訊息」，不能把 FASHN 的技術錯誤直接透出。
// checkStatus 的分支測試用 mock fetch 完全離線執行，不會真的打 FASHN API、不花錢。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FashnVTOProvider, mapFashnError } from "@/lib/vto/fashn";

describe("mapFashnError：錯誤轉譯", () => {
  it.each([
    "could not detect pose",
    "POSE ESTIMATION FAILED", // 大寫也要命中（轉譯用 lowercase 比對）
    "no person found in image",
    "detection failed",
  ])("姿勢／人物偵測失敗（%s）→ 引導改用正面半身照", (raw) => {
    const message = mapFashnError(raw);
    expect(message).toContain("上半身");
    expect(message).toContain("半身照");
  });

  it.each(["nsfw image", "content policy violation"])(
    "內容檢查未通過（%s）→ 引導改用日常穿著照片",
    (raw) => {
      expect(mapFashnError(raw)).toContain("內容檢查");
    }
  );

  it("同時命中多組關鍵字時，內容檢查分支優先", () => {
    // "NSFW detected" 同時含 "nsfw" 與 "detect"：內容審查的訊息更具體，
    // mapFashnError 因此先比對 nsfw/content、再比對 pose/person/detect，
    // 避免使用者在被內容審查擋下時，誤收到「偵測不到上半身」的引導。
    expect(mapFashnError("NSFW detected")).toContain("內容檢查");
  });

  it("未知錯誤 → 通用重試訊息，並附上截斷後的原始錯誤供除錯", () => {
    const message = mapFashnError("gpu quota exceeded");
    expect(message).toContain("請稍後再試");
    expect(message).toContain("gpu quota exceeded");
  });

  it("原始錯誤最多附 120 字，避免超長技術訊息灌進 UI", () => {
    const raw = "x".repeat(200);
    const message = mapFashnError(raw);
    expect(message).toContain("x".repeat(120));
    expect(message).not.toContain("x".repeat(121));
  });

  it("空字串 → 以 provider error 標示，訊息仍完整可讀", () => {
    const message = mapFashnError("");
    expect(message).toContain("provider error");
    expect(message).toContain("請稍後再試");
  });
});

describe("FashnVTOProvider.checkStatus：狀態分支", () => {
  const fetchMock = vi.fn();

  // 建最小可用的 Response 替身：checkStatus 只用到 ok / status / json / text / arrayBuffer
  function jsonResponse(
    body: unknown,
    init: { ok?: boolean; status?: number } = {}
  ): Response {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    // 測試不讀 .env.local，這裡固定給假 key，確保不會誤用真實金鑰
    vi.stubEnv("FASHN_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("以 Bearer key 查詢正確的 status 端點", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ status: "processing" }));
    await new FashnVTOProvider().checkStatus("job-123");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.fashn.ai/v1/status/job-123",
      { headers: { Authorization: "Bearer test-key" } }
    );
  });

  it.each(["starting", "in_queue", "processing"] as const)(
    "provider 回 %s → 對外一律是 processing（前端據此繼續輪詢）",
    async (status) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ status }));
      const result = await new FashnVTOProvider().checkStatus("job-123");
      expect(result).toEqual({ status: "processing" });
    }
  );

  it("completed → 下載結果圖並回傳 success", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: "completed", output: ["https://cdn.example/result.png"] })
      )
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => bytes.buffer,
      } as unknown as Response);

    const result = await new FashnVTOProvider().checkStatus("job-123");
    if (result.status !== "success") {
      throw new Error(`預期 success，實際為 ${result.status}`);
    }
    expect(result.resultImage).toEqual(Buffer.from(bytes));
  });

  it("completed 但結果圖下載失敗 → failed，訊息引導重新生成", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: "completed", output: ["https://cdn.example/result.png"] })
      )
      .mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response);

    const result = await new FashnVTOProvider().checkStatus("job-123");
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("重新生成"),
    });
  });

  it("failed（error 為物件）→ 錯誤經 mapFashnError 轉譯", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "failed", error: { name: "PoseError", message: "pose not detected" } })
    );
    const result = await new FashnVTOProvider().checkStatus("job-123");
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("上半身"),
    });
  });

  it("failed（error 為字串）→ 同樣經 mapFashnError 轉譯", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "failed", error: "nsfw content" })
    );
    const result = await new FashnVTOProvider().checkStatus("job-123");
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("內容檢查"),
    });
  });

  it("狀態查詢本身失敗（HTTP 非 2xx）→ failed 並附狀態碼", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 500 }));
    const result = await new FashnVTOProvider().checkStatus("job-123");
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("HTTP 500"),
    });
  });

  it("未設定 FASHN_API_KEY → 直接拒絕，訊息指向 .env.local 設定", async () => {
    // 空字串視同未設定：避免帶著空 Authorization 打真實 API
    vi.stubEnv("FASHN_API_KEY", "");
    await expect(new FashnVTOProvider().checkStatus("job-123")).rejects.toThrow(
      /FASHN_API_KEY/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
