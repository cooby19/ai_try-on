// Real-ESRGAN 放大 adapter（經 Replicate API）。
// 模型：nightmareai/real-esrgan（https://replicate.com/nightmareai/real-esrgan）
// API 文件：https://replicate.com/docs/topics/predictions/create-a-prediction
// API token 只從環境變數讀取，只存在於後端。
import sharp from "sharp";
import { toBase64DataUri } from "../images";
import type { ImageEnhancer } from "./enhancer";

const REPLICATE_API_BASE = "https://api.replicate.com/v1";

// 釘死 version hash（2026-07 查得的 latest_version），避免上游默默換權重
// 導致輸出風格漂移；要升級時改這個常數並重新人工驗證幾張結果圖。
export const REAL_ESRGAN_VERSION = "b3ef194191d13140337468c916c2c5b96dd0cb06dffc032a022a31807f6a5ea8";
export const REAL_ESRGAN_SCALE = 2 as const;

export class RealEsrganEnhancer implements ImageEnhancer {
  enhancerName = "realesrgan";
  // Replicate 跑 Nvidia T4（$0.000225/秒），官方頁面 p50 約 $0.0025/次。
  // 比照 VTO adapter 的 costEstimate：只做預估用途，不是精算帳單。
  costEstimate = 0.0025;

  private get apiToken(): string {
    const token = process.env.REPLICATE_API_TOKEN;
    if (!token) {
      throw new Error("尚未設定 REPLICATE_API_TOKEN，請在 .env.local 填入，或把 ENHANCE_PROVIDER 改回 none。");
    }
    return token;
  }

  async enhance(image: Buffer, signal?: AbortSignal): Promise<Buffer> {
    // Prefer: wait 讓 Replicate 以同步模式在單一請求內等結果（此處最多 30 秒，
    // 與上層 ENHANCE_TIMEOUT_MS 對齊），免去「送出 → 輪詢」的第二段往返；
    // 超過等待仍未完成的情況在下方視為失敗，由上層降級。
    const res = await fetch(`${REPLICATE_API_BASE}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        "Content-Type": "application/json",
        Prefer: "wait=30",
      },
      body: JSON.stringify({
        version: REAL_ESRGAN_VERSION,
        input: {
          // Replicate 支援 base64 data URI，不需要提供公開圖片網址（結果圖在私有 bucket）
          image: toBase64DataUri(image, "image/jpeg"),
          // 2×：864×1296 → 1728×2592，銳利度目標接近 Max 的 2k 檔位
          scale: REAL_ESRGAN_SCALE,
          // 臉部修復刻意不開：效果不可控且非本版目標，留待之後獨立評估
          face_enhance: false,
        },
      }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Replicate API 回應 ${res.status}：${body.slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      status?: string;
      output?: string | string[]; // 此模型回單一 URL 字串，但保守相容陣列格式
      error?: string | null;
    };
    // Prefer: wait 等到上限仍未完成會回 starting/processing——刻意不再額外輪詢，
    // 直接視為失敗讓上層降級回原圖，把 enhance 的總延遲鎖在硬逾時內。
    if (data.status !== "succeeded") {
      throw new Error(
        `Replicate 放大未完成（status: ${data.status ?? "unknown"}${data.error ? `，${String(data.error).slice(0, 200)}` : ""}）`
      );
    }
    const outputUrl = Array.isArray(data.output) ? data.output[0] : data.output;
    if (!outputUrl) {
      throw new Error("Replicate 回報成功但未附結果圖網址");
    }

    const imageRes = await fetch(outputUrl, { signal });
    if (!imageRes.ok) {
      throw new Error(`放大結果圖下載失敗（HTTP ${imageRes.status}）`);
    }
    const upscaled = Buffer.from(await imageRes.arrayBuffer());
    // Real-ESRGAN 輸出 PNG，1728×2592 的 PNG 會有數 MB；轉 JPEG 才與結果 bucket 的
    // contentType: "image/jpeg" 一致，signed URL 的下載量也小得多。
    return sharp(upscaled).jpeg({ quality: 92 }).toBuffer();
  }
}
