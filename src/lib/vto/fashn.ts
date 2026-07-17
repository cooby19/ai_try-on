// FASHN Virtual Try-On API adapter（https://docs.fashn.ai）
// 流程：POST /v1/run 送出任務 → GET /v1/status/{id} 輪詢 → completed 後下載結果圖。
// API key 只從環境變數讀取，只存在於後端。
import { toBase64DataUri } from "../images";
import {
  VTOProviderError,
  type VTOImageInput,
  type VTOProvider,
  type VTOSubmitInput,
  type VTOStatusResult,
} from "./provider";

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
    if (input.generationConfig.providerName !== "fashn") {
      throw new Error("FASHN v1.6 收到不相符的 generation config");
    }
    const config = input.generationConfig;
    const res = await fetch(`${FASHN_API_BASE}/run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // FASHN 新版 API 格式：model_name + inputs（2025 改版）
        model_name: config.modelName,
        inputs: {
          // FASHN 支援 base64 data URI，因此不需要提供公開圖片網址
          model_image: toBase64DataUri(input.personImage, "image/jpeg"),
          garment_image: toBase64DataUri(input.garmentImage, "image/png"),
          category: config.inputs.category,
          // quality 與 balanced 在 v1.6 同價（皆 1 credit/張），是零成本的品質升級；
          // quality 約 12–17 秒，仍在前端 120 秒輪詢上限內。
          mode: config.inputs.mode,
          seed: config.seed,
          // 商品圖都是平拍去背圖，明示 flat-lay 比讓 auto 自行猜測更穩定。
          garment_photo_type: config.inputs.garmentPhotoType,
          num_samples: config.inputs.outputCount,
          // 明示輸出 JPEG，與後端儲存的 contentType: "image/jpeg" 一致（預設會回 PNG）。
          output_format: config.inputs.outputFormat,
        },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new VTOProviderError(
        `FASHN API 回應 ${res.status}：${body.slice(0, 300)}`,
        "provider_submit",
        res.status,
      );
    }
    const data = (await res.json()) as { id?: string; error?: string };
    if (!data.id) {
      throw new VTOProviderError(
        `FASHN API 未回傳任務 ID：${data.error ?? "unknown"}`,
        "provider_submit",
      );
    }
    return { providerJobId: data.id };
  }

  async checkStatus(providerJobId: string, _ctx?: VTOImageInput): Promise<VTOStatusResult> {
    const apiKey = this.apiKey;
    let res: Response;
    try {
      res = await fetch(`${FASHN_API_BASE}/status/${providerJobId}`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
    } catch (cause) {
      throw new VTOProviderError("FASHN 狀態查詢失敗，請稍後再試一次。", "provider_poll", undefined, { cause });
    }
    if (!res.ok) {
      // 單次狀態查詢失敗（429 rate limit、5xx 瞬斷等）不代表任務失敗——
      // FASHN 端任務可能已完成且已計費，此時標 failed 會報廢已付費的結果。
      // 回 processing 讓前端 120 秒輪詢窗自然重試；即使是終局性的 4xx（如 401），
      // 最壞情況也只是等滿 120 秒逾時，不會誤殺可救回的任務。
      console.warn(`FASHN 狀態查詢暫時失敗（HTTP ${res.status}），等待下次輪詢重試：${providerJobId}`);
      return { status: "processing" };
    }
    const data = (await res.json()) as {
      status: "starting" | "in_queue" | "processing" | "completed" | "failed";
      output?: string[];
      error?: { name?: string; message?: string } | string | null;
    };

    if (data.status === "completed" && data.output?.[0]) {
      let imageRes: Response;
      try {
        imageRes = await fetch(data.output[0]);
      } catch (cause) {
        throw new VTOProviderError(
          "AI 結果圖下載失敗，請稍後再試一次。",
          "provider_output_download",
          undefined,
          { cause },
        );
      }
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
      return { status: "failed", errorMessage: mapFashnError(raw), errorCode: "PROVIDER_REJECTED" };
    }
    return { status: "processing" };
  }
}

// 把 FASHN 的技術性錯誤轉成使用者「可操作」的訊息（規格書第八、九節）。
// export 是為了讓單元測試能直接驗證錯誤轉譯（行為不變，仍僅供本模組與測試使用）。
export function mapFashnError(raw: string): string {
  const lower = raw.toLowerCase();
  // 內容審查需先於偵測分支比對：這類錯誤（如 "NSFW detected"）常同時含 "detect"，
  // 先比對 nsfw/content 才不會被偵測分支攔截、回傳誤導的「偵測不到上半身」訊息。
  if (lower.includes("nsfw") || lower.includes("content")) {
    return "這張照片未通過內容檢查，請改用一般的日常穿著照片。";
  }
  if (lower.includes("pose") || lower.includes("person") || lower.includes("detect")) {
    return "這張照片可能不適合 AI 試穿：偵測不到清楚的上半身。建議改用正面、手自然放下、上衣清楚的半身照再試一次。";
  }
  return `AI 生成暫時失敗，請稍後再試一次。若持續失敗，建議換一張光線較亮、上衣清楚的正面半身照。（${raw.slice(0, 120) || "provider error"}）`;
}
