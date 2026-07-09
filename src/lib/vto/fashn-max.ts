// FASHN「Try-On Max」Virtual Try-On API adapter（https://docs.fashn.ai）
// 與 tryon-v1.6 共用同一組端點與同一把 API key，但輸入欄位名不同（見 submit() 註解），
// 用途是和 tryon-v1.6 做品質對比。API key 只從環境變數讀取，只存在於後端。
import { toBase64DataUri } from "../images";
import { mapFashnError } from "./fashn"; // 直接重用 v1.6 的錯誤轉譯，避免複製一份、也不改動其行為
import type { VTOProvider, VTOSubmitInput, VTOStatusResult } from "./provider";

const FASHN_API_BASE = "https://api.fashn.ai/v1";

export class FashnMaxVTOProvider implements VTOProvider {
  providerName = "fashn-max";
  // Max 的 balanced + 1k 約 2 credits/張，是 v1.6（1 credit）的兩倍；換算約 USD 0.15。
  // 實際請以官網為準——這裡比照 fashn.ts 只做「預估成本」用途，不是精算帳單。
  costEstimate = 0.15;
  requiresImagesOnPoll = false; // Max 端已保存任務，輪詢不需重傳圖片（同 v1.6）

  private get apiKey(): string {
    // Max 與 v1.6 共用同一把 FASHN_API_KEY，不需要另設環境變數
    const key = process.env.FASHN_API_KEY;
    if (!key) {
      throw new Error("尚未設定 FASHN_API_KEY，請在 .env.local 填入 API key，或把 VTO_PROVIDER 改回 mock。");
    }
    return key;
  }

  async submit(input: VTOSubmitInput): Promise<{ providerJobId: string }> {
    const res = await fetch(`${FASHN_API_BASE}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // Try-On Max 的 model_name；與 v1.6 共用 /run 端點但走不同模型
        model_name: "tryon-max",
        inputs: {
          // ⚠️ 欄位名和 v1.6 不同：Max 的「衣服圖」欄位叫 product_image（v1.6 是 garment_image）。
          // 這裡放的是 input.garmentImage（上衣圖），不是人物照，別放錯。
          product_image: toBase64DataUri(input.garmentImage, "image/png"),
          // 人物照欄位名和 v1.6 相同（model_image）
          model_image: toBase64DataUri(input.personImage, "image/jpeg"),
          // Max 的速度/品質欄位叫 generation_mode（v1.6 是 mode）；先用 balanced 做基準對比
          generation_mode: "balanced",
          // Max 特有的解析度欄位；1k 為對比基準（2k/4k 更貴）
          resolution: "1k",
          // 每次送出用隨機 seed（0 ~ 2^32-1）：同 v1.6，避免「重新生成」每次產出同一張圖白扣額度
          seed: Math.floor(Math.random() * 2 ** 32),
          // Max 用 num_images 控制輸出張數（v1.6 是 num_samples）；這一版只要 1 張
          num_images: 1,
          // 明示輸出 JPEG，與後端儲存的 contentType: "image/jpeg" 一致（預設會回 PNG）
          output_format: "jpeg",
          // Max 支援可選的文字指令 prompt，這一版先留空字串（純粹換衣、不加額外語意）
          prompt: "",
          // 注意：Max「沒有」category / garment_photo_type / segmentation_free，
          // 所以 input.garmentType 在此用不到，刻意忽略，不要傳這些欄位。
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`FASHN API 回應 ${res.status}：${body.slice(0, 300)}`);
    }
    const data = (await res.json()) as { id?: string; error?: string };
    if (!data.id) {
      throw new Error(`FASHN API 未回傳任務 ID：${data.error ?? "unknown"}`);
    }
    return { providerJobId: data.id };
  }

  async checkStatus(providerJobId: string, _ctx?: VTOSubmitInput): Promise<VTOStatusResult> {
    // 狀態機與下載邏輯和 v1.6 相同（completed 回應格式一致：{ id, status, output:[url], error }）
    const res = await fetch(`${FASHN_API_BASE}/status/${providerJobId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      // 單次狀態查詢失敗（429 rate limit、5xx 瞬斷等）不代表任務失敗——
      // FASHN 端任務可能已完成且已計費，此時標 failed 會報廢已付費的結果。
      // 回 processing 讓前端 120 秒輪詢窗自然重試（與 fashn.ts 同構的取捨）。
      console.warn(`FASHN 狀態查詢暫時失敗（HTTP ${res.status}），等待下次輪詢重試：${providerJobId}`);
      return { status: "processing" };
    }
    const data = (await res.json()) as {
      status: "starting" | "in_queue" | "processing" | "completed" | "failed";
      output?: string[];
      error?: { name?: string; message?: string } | string | null;
    };

    if (data.status === "completed" && data.output?.[0]) {
      const imageRes = await fetch(data.output[0]);
      if (!imageRes.ok) {
        // CDN 偶發失敗：任務其實已完成，下次輪詢會重新拿到 completed 狀態
        // （含可能刷新的 output URL）再重試下載，不要因單次下載失敗報廢結果。
        console.warn(`FASHN 結果圖下載暫時失敗（HTTP ${imageRes.status}），等待下次輪詢重試：${providerJobId}`);
        return { status: "processing" };
      }
      return { status: "success", resultImage: Buffer.from(await imageRes.arrayBuffer()) };
    }
    if (data.status === "failed") {
      const raw = typeof data.error === "string" ? data.error : data.error?.message ?? "";
      return { status: "failed", errorMessage: mapFashnError(raw) };
    }
    return { status: "processing" };
  }
}
