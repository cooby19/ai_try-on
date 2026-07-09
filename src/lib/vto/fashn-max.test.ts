// fashn-max.ts 的回歸保護：Try-On Max 的輸入欄位名和 v1.6 不同，最容易出的錯是
// 「衣服圖 / 人物照放錯欄位」以及誤傳 v1.6 才有的 category 等欄位——這裡把這些釘死。
// 錯誤轉譯與狀態機直接重用 v1.6 的 mapFashnError，因此只補一兩個分支確認接線正確。
// 全部用 mock fetch 離線執行，不會真的打 FASHN API、不花錢。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FashnMaxVTOProvider } from "@/lib/vto/fashn-max";

describe("FashnMaxVTOProvider.submit：Try-On Max 請求格式", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubEnv("FASHN_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  function lastSubmitBody(): { model_name: string; inputs: Record<string, unknown> } {
    const [, init] = fetchMock.mock.calls.at(-1)!;
    return JSON.parse((init as RequestInit).body as string);
  }

  it("以 tryon-max 模型、Max 專屬欄位送出 /run 端點", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: "max-job-1" }),
    } as unknown as Response);

    // 用不同 bytes 才能驗證「衣服圖 / 人物照」有沒有放對欄位
    const personImage = Buffer.from([1, 2, 3]);
    const garmentImage = Buffer.from([9, 9, 9]);
    const result = await new FashnMaxVTOProvider().submit({
      personImage,
      garmentImage,
      garmentType: "tops",
    });
    expect(result).toEqual({ providerJobId: "max-job-1" });

    const [url] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("https://api.fashn.ai/v1/run");
    const { model_name, inputs } = lastSubmitBody();
    expect(model_name).toBe("tryon-max");

    // ⚠️ 核心契約：product_image 放「衣服圖」、model_image 放「人物照」，不能對調
    expect(inputs.product_image).toBe(`data:image/png;base64,${garmentImage.toString("base64")}`);
    expect(inputs.model_image).toBe(`data:image/jpeg;base64,${personImage.toString("base64")}`);

    // Max 專屬欄位名（和 v1.6 不同）
    expect(inputs.generation_mode).toBe("balanced");
    expect(inputs.resolution).toBe("1k");
    expect(inputs.num_images).toBe(1);
    expect(inputs.output_format).toBe("jpeg");
    expect(inputs.prompt).toBe("");

    // Max 沒有這些欄位，誤傳會被 API 拒絕或行為不明——確保我們不傳
    expect(inputs).not.toHaveProperty("category");
    expect(inputs).not.toHaveProperty("garment_image"); // v1.6 的欄位名，不該出現
    expect(inputs).not.toHaveProperty("mode"); // v1.6 的欄位名，不該出現
    expect(inputs).not.toHaveProperty("garment_photo_type");
    expect(inputs).not.toHaveProperty("segmentation_free");
  });

  it("每次送出帶隨機整數 seed（0 ~ 2^32-1），讓重新生成有不同結果", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ id: "max-job-1" }),
    } as unknown as Response);

    const provider = new FashnMaxVTOProvider();
    const input = {
      personImage: Buffer.from([1]),
      garmentImage: Buffer.from([2]),
      garmentType: "tops" as const,
    };
    await provider.submit(input);
    const seedA = lastSubmitBody().inputs.seed as number;
    await provider.submit(input);
    const seedB = lastSubmitBody().inputs.seed as number;

    for (const seed of [seedA, seedB]) {
      expect(Number.isInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThanOrEqual(2 ** 32 - 1);
    }
    expect(seedA).not.toBe(seedB);
  });
});

describe("FashnMaxVTOProvider.checkStatus：狀態機重用 v1.6 邏輯", () => {
  const fetchMock = vi.fn();

  function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as unknown as Response;
  }

  beforeEach(() => {
    vi.stubEnv("FASHN_API_KEY", "test-key");
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("completed → 從 output[0] 下載結果圖並回傳 success", async () => {
    const bytes = new Uint8Array([5, 6, 7, 8]);
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: "completed", output: ["https://cdn.example/max.jpg"] })
      )
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => bytes.buffer,
      } as unknown as Response);

    const result = await new FashnMaxVTOProvider().checkStatus("max-job-1");
    if (result.status !== "success") {
      throw new Error(`預期 success，實際為 ${result.status}`);
    }
    expect(result.resultImage).toEqual(Buffer.from(bytes));
  });

  it("failed → 錯誤經重用的 mapFashnError 轉成可操作繁中訊息", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ status: "failed", error: "nsfw content" })
    );
    const result = await new FashnMaxVTOProvider().checkStatus("max-job-1");
    expect(result).toMatchObject({
      status: "failed",
      errorMessage: expect.stringContaining("內容檢查"),
    });
  });

  // 下面兩個暫時性分支雖與 fashn.test.ts 同構，但 Max 的 checkStatus 是獨立複製的
  // 程式碼（非共用函式），不能只靠 v1.6 的測試蓋住，必須各自釘住。

  it("狀態查詢本身失敗（HTTP 429）→ processing，交給前端 120 秒輪詢窗重試", async () => {
    // 單次查詢失敗不代表任務失敗：Max 端任務可能已完成且已計費（2 credits/張，
    // 是 v1.6 的兩倍），此時標 failed 報廢的成本更高。
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { ok: false, status: 429 }));
    const result = await new FashnMaxVTOProvider().checkStatus("max-job-1");
    expect(result).toEqual({ status: "processing" });
  });

  it("completed 但結果圖下載失敗 → processing（下次輪詢重新拿 completed 再重試下載）", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ status: "completed", output: ["https://cdn.example/max.jpg"] })
      )
      .mockResolvedValueOnce({ ok: false, status: 503 } as unknown as Response);

    const result = await new FashnMaxVTOProvider().checkStatus("max-job-1");
    expect(result).toEqual({ status: "processing" });
  });
});
