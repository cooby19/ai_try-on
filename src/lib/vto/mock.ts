// Mock provider：不需要任何 API key，讓整個流程（上傳 → 生成 → 輪詢 → 結果 → 回饋）
// 在本機就能跑通。送出後約 3 秒「完成」，結果圖 = 人物照 + 上衣縮圖 + 「MOCK 預覽」浮水印，
// 方便 demo 時看得出「這張是生成結果」。
import sharp from "sharp";
import type { VTOImageInput, VTOProvider, VTOSubmitInput, VTOStatusResult } from "./provider";

const MOCK_DELAY_MS = 3000;

export class MockVTOProvider implements VTOProvider {
  providerName = "mock";
  costEstimate = 0; // mock 不花錢
  requiresImagesOnPoll = true; // 合成結果圖時需要原始人物照與上衣圖

  async submit(_input: VTOSubmitInput): Promise<{ providerJobId: string }> {
    if (_input.generationConfig.providerName !== "mock") {
      throw new Error("Mock provider 收到不相符的 generation config");
    }
    // 把送出時間編進任務 ID，checkStatus 就不需要在記憶體裡存狀態
    // （serverless 環境下每次請求可能是不同 process）
    return { providerJobId: `mock_${Date.now()}` };
  }

  async checkStatus(providerJobId: string, ctx?: VTOImageInput): Promise<VTOStatusResult> {
    const submittedAt = Number(providerJobId.replace("mock_", ""));
    if (!Number.isFinite(submittedAt) || !ctx) {
      return {
        status: "failed",
        errorMessage: "mock 任務資料不完整，請重新生成一次。",
        errorCode: "PROVIDER_REJECTED",
      };
    }
    if (Date.now() - submittedAt < MOCK_DELAY_MS) {
      return { status: "processing" };
    }
    const resultImage = await composeMockResult(ctx.personImage, ctx.garmentImage);
    return { status: "success", resultImage };
  }
}

// 合成示範結果圖：人物照置底，上衣圖疊在中間偏下（模擬「換上衣」），加上浮水印
async function composeMockResult(personImage: Buffer, garmentImage: Buffer): Promise<Buffer> {
  const person = sharp(personImage);
  const meta = await person.metadata();
  const width = meta.width ?? 768;
  const height = meta.height ?? 1024;

  const garmentWidth = Math.round(width * 0.5);
  const garment = await sharp(garmentImage)
    .resize({ width: garmentWidth })
    .ensureAlpha(0.92)
    .png()
    .toBuffer();
  const garmentMeta = await sharp(garment).metadata();
  const garmentHeight = garmentMeta.height ?? garmentWidth;

  const badge = Buffer.from(
    `<svg width="${width}" height="60">
       <rect x="0" y="0" width="${width}" height="60" fill="rgba(0,0,0,0.55)"/>
       <text x="${width / 2}" y="38" text-anchor="middle"
             font-family="Helvetica, 'PingFang TC', sans-serif" font-size="26" fill="#ffffff">
         MOCK 預覽 — 僅供流程展示，非真實 AI 生成
       </text>
     </svg>`
  );

  return person
    .composite([
      {
        input: garment,
        left: Math.max(0, Math.round((width - garmentWidth) / 2)),
        top: Math.max(0, Math.round(height * 0.45 - garmentHeight / 2)),
      },
      { input: badge, left: 0, top: Math.max(0, height - 60) },
    ])
    .jpeg({ quality: 88 })
    .toBuffer();
}
