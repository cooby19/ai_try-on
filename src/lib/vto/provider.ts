// Virtual Try-On provider 抽象層（規格書第四節）。
//
// 規格書要求的 generateTryOn(personImageUrl, garmentImageUrl, options) 在這裡
// 拆成 submit + checkStatus 兩步，原因是主流 VTO API（FASHN、fal.ai）都是
// 「送出任務 → 輪詢結果」的非同步模式；拆開後 serverless route 不需要長時間等待。
//
// 要新增 provider（例如 fal.ai）：實作這個介面，然後在 index.ts 的 factory 註冊即可。

export interface VTOSubmitInput {
  personImage: Buffer;  // 人物照（已由後端正規化為 JPEG）
  garmentImage: Buffer; // 上衣圖（PNG）
  garmentType: "tops";  // 第一版只支援上衣
}

export type VTOStatusResult =
  | { status: "processing" }
  | { status: "success"; resultImage: Buffer }
  | { status: "failed"; errorMessage: string };

export interface VTOProvider {
  providerName: string;
  costEstimate: number; // 每次生成的預估成本（USD）

  // 輪詢時是否需要原始圖片（mock 需要用來合成結果圖；真實 API 不需要，
  // 設 false 可避免每次輪詢都從 Storage 重新下載圖片）
  requiresImagesOnPoll: boolean;

  // 送出試穿任務，回傳 provider 端的任務 ID
  submit(input: VTOSubmitInput): Promise<{ providerJobId: string }>;

  // 查詢任務進度。ctx 提供原始圖片，只有 requiresImagesOnPoll = true 的 provider 會收到
  checkStatus(providerJobId: string, ctx?: VTOSubmitInput): Promise<VTOStatusResult>;
}
