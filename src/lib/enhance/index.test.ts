// enhance/index.ts 的回歸保護：釘住三條行為邊界——
// 1. ENHANCE_PROVIDER=none（或未設）時「零外部呼叫」，行為與加入此功能前一致（回滾承諾）；
// 2. 只放大 v1.6（fashn）的結果，mock / fashn-max 一律跳過（成本策略）；
// 3. 放大失敗（錯誤、逾時、設定不完整）一律降級回原圖、不往外 throw——
//    使用者已扣額度，後處理不能讓整次生成報廢。
// 全部離線執行：fetch 用 mock，不打真實 Replicate API、不花錢。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { enhanceResultImage, getImageEnhancer, ENHANCE_TIMEOUT_MS } from "@/lib/enhance";

const fetchMock = vi.fn();

// 產一張最小可用的 JPEG 當「VTO 原圖」：內容不重要，重點是能被 sharp 處理
async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 80, b: 80 } },
  })
    .jpeg()
    .toBuffer();
}

// 產一張 PNG 當「Replicate 放大結果」：realesrgan adapter 會用 sharp 把它轉成 JPEG，
// 所以必須是真實可解碼的圖片位元組，不能拿隨便的 byte 陣列充數
async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 80, g: 80, b: 200 } },
  })
    .png()
    .toBuffer();
}

// 模擬「prediction 成功 → 下載結果圖」的兩段 fetch 回應
async function mockSuccessfulReplicate(): Promise<void> {
  const upscaled = await tinyPng();
  fetchMock
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ status: "succeeded", output: "https://replicate.delivery/out.png" }),
    } as unknown as Response)
    .mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => new Uint8Array(upscaled).buffer,
    } as unknown as Response);
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  // 測試不讀 .env.local，固定給假 token，確保不會誤用真實金鑰
  vi.stubEnv("REPLICATE_API_TOKEN", "test-token");
  // 靜音並監看 log：降級是「刻意吞錯」，必須留下紀錄才能事後追查
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  fetchMock.mockReset();
});

describe("getImageEnhancer：factory 與停用邏輯", () => {
  it("ENHANCE_PROVIDER 未設 → 預設 none，回 null", () => {
    expect(getImageEnhancer()).toBeNull();
  });

  it("ENHANCE_PROVIDER=none → 回 null", () => {
    vi.stubEnv("ENHANCE_PROVIDER", "none");
    expect(getImageEnhancer()).toBeNull();
  });

  it("未知值 → 停用並警告，而非 throw（設定打錯不該讓生成報廢）", () => {
    vi.stubEnv("ENHANCE_PROVIDER", "gfpgan");
    expect(getImageEnhancer()).toBeNull();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("gfpgan"));
  });

  it("realesrgan → 回可用的 enhancer", () => {
    vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
    expect(getImageEnhancer()?.enhancerName).toBe("realesrgan");
  });
});

describe("enhanceResultImage：停用與跳過（零外部呼叫）", () => {
  it("ENHANCE_PROVIDER 未設 → 原圖直回、完全不呼叫外部 API", async () => {
    const original = await tinyJpeg();
    const outcome = await enhanceResultImage(original, "fashn");
    expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ENHANCE_PROVIDER=none → 同上（回滾開關的行為承諾）", async () => {
    vi.stubEnv("ENHANCE_PROVIDER", "none");
    const original = await tinyJpeg();
    const outcome = await enhanceResultImage(original, "fashn");
    expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["mock", "fashn-max"])(
    "已啟用放大，但 VTO provider 是 %s → 跳過（只有 v1.6 有解析度缺口）",
    async (provider) => {
      vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
      const original = await tinyJpeg();
      const outcome = await enhanceResultImage(original, provider);
      expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});

describe("enhanceResultImage：成功放大", () => {
  it("fashn + realesrgan → 回放大圖、enhanced=true、附放大成本", async () => {
    vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
    await mockSuccessfulReplicate();

    const original = await tinyJpeg();
    const outcome = await enhanceResultImage(original, "fashn");

    expect(outcome.enhanced).toBe(true);
    // extraCost 來自 adapter 的 costEstimate，route 會把它加進 job.cost_estimate
    expect(outcome.extraCost).toBeGreaterThan(0);
    expect(outcome.image.equals(original)).toBe(false);
    // adapter 會把 Replicate 的 PNG 轉成 JPEG（與結果 bucket 的 contentType 一致）
    const meta = await sharp(outcome.image).metadata();
    expect(meta.format).toBe("jpeg");
  });
});

describe("enhanceResultImage：失敗降級（不 throw、回原圖）", () => {
  it("Replicate 回 5xx → 降級回原圖，job 不受影響", async () => {
    vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => "internal error",
    } as unknown as Response);

    const original = await tinyJpeg();
    const outcome = await enhanceResultImage(original, "fashn");
    expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
    expect(console.error).toHaveBeenCalled(); // 降級必須留下紀錄
  });

  it("網路層直接 reject → 同樣降級回原圖", async () => {
    vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
    fetchMock.mockRejectedValueOnce(new Error("network down"));

    const original = await tinyJpeg();
    const outcome = await enhanceResultImage(original, "fashn");
    expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
  });

  it("REPLICATE_API_TOKEN 未設 → adapter throw，但對外仍是降級回原圖", async () => {
    vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
    vi.stubEnv("REPLICATE_API_TOKEN", "");

    const original = await tinyJpeg();
    const outcome = await enhanceResultImage(original, "fashn");
    expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it(`超過硬逾時（${ENHANCE_TIMEOUT_MS}ms）→ 中止呼叫並降級回原圖`, async () => {
    vi.useFakeTimers();
    try {
      vi.stubEnv("ENHANCE_PROVIDER", "realesrgan");
      // 模擬掛住的外部 API：永不 resolve，只在收到 abort 時 reject——
      // 驗證 enhanceResultImage 的 AbortController 真的有接到底層 fetch
      fetchMock.mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      );

      const original = Buffer.from([9, 9, 9]); // 逾時路徑不會碰 sharp，隨意位元組即可
      const promise = enhanceResultImage(original, "fashn");
      await vi.advanceTimersByTimeAsync(ENHANCE_TIMEOUT_MS);
      const outcome = await promise;
      expect(outcome).toEqual({ image: original, enhanced: false, extraCost: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});
