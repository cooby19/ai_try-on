// FASHN Virtual Try-On API adapter（https://docs.fashn.ai）
// 流程：POST /v1/run 送出任務 → GET /v1/status/{id} 輪詢 → completed 後下載結果圖。
// API key 只從環境變數讀取，只存在於後端。
import { toBase64DataUri } from "../images";
import type { VTOProvider, VTOSubmitInput, VTOStatusResult } from "./provider";

const FASHN_API_BASE = "https://api.fashn.ai/v1";

export class FashnVTOProvider implements VTOProvider {
  providerName = "fashn";
  costEstimate = 0.075; // USD / 張（依 FASHN 定價，實際請以官網為準）
  requiresImagesOnPoll = false; // FASHN 端已保存任務，輪詢不需重傳圖片

  private get apiKey(): string {
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
        // FASHN 新版 API 格式：model_name + inputs（2025 改版）
        model_name: "tryon-v1.6",
        inputs: {
          // FASHN 支援 base64 data URI，因此不需要提供公開圖片網址
          model_image: toBase64DataUri(input.personImage, "image/jpeg"),
          garment_image: toBase64DataUri(input.garmentImage, "image/png"),
          category: input.garmentType, // "tops"
          mode: "balanced",
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
    const res = await fetch(`${FASHN_API_BASE}/status/${providerJobId}`, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    if (!res.ok) {
      return { status: "failed", errorMessage: `FASHN 狀態查詢失敗（HTTP ${res.status}）` };
    }
    const data = (await res.json()) as {
      status: "starting" | "in_queue" | "processing" | "completed" | "failed";
      output?: string[];
      error?: { name?: string; message?: string } | string | null;
    };

    if (data.status === "completed" && data.output?.[0]) {
      const imageRes = await fetch(data.output[0]);
      if (!imageRes.ok) {
        return { status: "failed", errorMessage: "結果圖下載失敗，請重新生成一次。" };
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

// 把 FASHN 的技術性錯誤轉成使用者「可操作」的訊息（規格書第八、九節）。
// export 是為了讓單元測試能直接驗證錯誤轉譯（行為不變，仍僅供本模組與測試使用）。
export function mapFashnError(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower.includes("pose") || lower.includes("person") || lower.includes("detect")) {
    return "這張照片可能不適合 AI 試穿：偵測不到清楚的上半身。建議改用正面、手自然放下、上衣清楚的半身照再試一次。";
  }
  if (lower.includes("nsfw") || lower.includes("content")) {
    return "這張照片未通過內容檢查，請改用一般的日常穿著照片。";
  }
  return `AI 生成暫時失敗，請稍後再試一次。若持續失敗，建議換一張光線較亮、上衣清楚的正面半身照。（${raw.slice(0, 120) || "provider error"}）`;
}
