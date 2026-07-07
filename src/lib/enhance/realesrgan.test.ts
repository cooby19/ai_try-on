// realesrgan.ts 的回歸保護：釘住送給 Replicate 的請求格式（version 釘死、2× 放大、
// 不開臉部修復）與各失敗分支「一律 throw」的契約——降級決策屬於上層
// enhanceResultImage，adapter 自己吞錯會讓失敗悄悄變成「假成功」。
// 全部離線執行：fetch 用 mock，不打真實 Replicate API、不花錢。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { RealEsrganEnhancer } from "@/lib/enhance/realesrgan";

const fetchMock = vi.fn();

async function tinyJpeg(): Promise<Buffer> {
  return sharp({
    create: { width: 4, height: 4, channels: 3, background: { r: 200, g: 80, b: 80 } },
  })
    .jpeg()
    .toBuffer();
}

async function tinyPng(): Promise<Buffer> {
  return sharp({
    create: { width: 8, height: 8, channels: 3, background: { r: 80, g: 80, b: 200 } },
  })
    .png()
    .toBuffer();
}

function predictionResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubEnv("REPLICATE_API_TOKEN", "test-token");
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  fetchMock.mockReset();
});

describe("RealEsrganEnhancer.enhance：請求格式", () => {
  it("以 Bearer token + Prefer: wait 送出正確端點與參數", async () => {
    const upscaled = await tinyPng();
    fetchMock
      .mockResolvedValueOnce(
        predictionResponse({ status: "succeeded", output: "https://replicate.delivery/out.png" })
      )
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(upscaled).buffer,
      } as unknown as Response);

    const result = await new RealEsrganEnhancer().enhance(await tinyJpeg());

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.replicate.com/v1/predictions");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer test-token");
    // Prefer: wait 讓 Replicate 同步等結果，免去第二段輪詢往返（見 realesrgan.ts 註解）
    expect(headers.Prefer).toBe("wait=30");

    const body = JSON.parse((init as RequestInit).body as string);
    // version 釘死：上游默默換權重會造成輸出風格漂移，升級必須是有意識的動作
    expect(body.version).toMatch(/^[a-f0-9]{64}$/);
    expect(body.input.scale).toBe(2); // 864×1296 → 1728×2592
    expect(body.input.face_enhance).toBe(false); // 臉部修復刻意不開，留待下一版
    expect(body.input.image).toMatch(/^data:image\/jpeg;base64,/);

    // 輸出必須轉成 JPEG（與結果 bucket 的 contentType: image/jpeg 一致）
    const meta = await sharp(result).metadata();
    expect(meta.format).toBe("jpeg");
  });

  it("output 為陣列時取第一張（保守相容兩種回應格式）", async () => {
    const upscaled = await tinyPng();
    fetchMock
      .mockResolvedValueOnce(
        predictionResponse({ status: "succeeded", output: ["https://replicate.delivery/out.png"] })
      )
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(upscaled).buffer,
      } as unknown as Response);

    const result = await new RealEsrganEnhancer().enhance(await tinyJpeg());
    expect((await sharp(result).metadata()).format).toBe("jpeg");
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://replicate.delivery/out.png",
      expect.anything()
    );
  });
});

describe("RealEsrganEnhancer.enhance：失敗分支一律 throw", () => {
  it("未設 REPLICATE_API_TOKEN → 直接拒絕、不發出任何請求", async () => {
    // 空字串視同未設定：避免帶著空 Authorization 打真實 API
    vi.stubEnv("REPLICATE_API_TOKEN", "");
    await expect(new RealEsrganEnhancer().enhance(await tinyJpeg())).rejects.toThrow(
      /REPLICATE_API_TOKEN/
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("HTTP 非 2xx（如 402 餘額不足）→ throw 並附狀態碼", async () => {
    fetchMock.mockResolvedValueOnce(
      predictionResponse({ detail: "insufficient credit" }, { ok: false, status: 402 })
    );
    await expect(new RealEsrganEnhancer().enhance(await tinyJpeg())).rejects.toThrow(/402/);
  });

  it("Prefer: wait 到時仍未完成（status: processing）→ throw，不再額外輪詢", async () => {
    // 刻意不輪詢：把 enhance 總延遲鎖在硬逾時內，等太久的放大直接交給上層降級
    fetchMock.mockResolvedValueOnce(predictionResponse({ status: "processing" }));
    await expect(new RealEsrganEnhancer().enhance(await tinyJpeg())).rejects.toThrow(
      /processing/
    );
  });

  it("succeeded 但沒附結果圖網址 → throw", async () => {
    fetchMock.mockResolvedValueOnce(predictionResponse({ status: "succeeded", output: [] }));
    await expect(new RealEsrganEnhancer().enhance(await tinyJpeg())).rejects.toThrow(
      /未附結果圖網址/
    );
  });

  it("結果圖下載失敗 → throw 並附狀態碼", async () => {
    fetchMock
      .mockResolvedValueOnce(
        predictionResponse({ status: "succeeded", output: "https://replicate.delivery/out.png" })
      )
      .mockResolvedValueOnce({ ok: false, status: 404 } as unknown as Response);
    await expect(new RealEsrganEnhancer().enhance(await tinyJpeg())).rejects.toThrow(/404/);
  });

  it("上層傳入的 AbortSignal 會接到每一段 fetch（硬逾時能真正中止請求）", async () => {
    const upscaled = await tinyPng();
    fetchMock
      .mockResolvedValueOnce(
        predictionResponse({ status: "succeeded", output: "https://replicate.delivery/out.png" })
      )
      .mockResolvedValueOnce({
        ok: true,
        arrayBuffer: async () => new Uint8Array(upscaled).buffer,
      } as unknown as Response);

    const controller = new AbortController();
    await new RealEsrganEnhancer().enhance(await tinyJpeg(), controller.signal);

    for (const [, init] of fetchMock.mock.calls) {
      expect((init as RequestInit).signal).toBe(controller.signal);
    }
  });
});
