// 結果圖放大（enhance）後處理的抽象層。
//
// 為什麼獨立於 VTOProvider：放大是「結果後處理」的產品策略——FASHN tryon-v1.6
// 原生輸出固定 864×1296、不超過輸入解析度，這是它與 tryon-max（可選 1k/2k/4k）
// 品質差距的主因；對 v1.6 的結果補一道 2× 放大即可用遠低於 Max 的成本拉近銳利度。
// 這個策略不屬於任何一家 VTO API，所以拆成獨立介面，VTOProvider 與
// mock / fashn / fashn-max 三個 adapter 完全不用動。
//
// 要新增放大方案：實作這個介面，在 index.ts 的 factory 註冊即可。
// 介面刻意只收一張圖、回一張圖——未來的臉部修復（GFPGAN / CodeFormer）
// 也適用同一契約，屆時同樣新增 adapter 就好，不必改介面。

export interface ImageEnhancer {
  enhancerName: string;
  costEstimate: number; // 每張圖的預估放大成本（USD），實際執行放大時會計入 job.cost_estimate

  // 放大一張結果圖（輸入輸出都是 JPEG buffer）。
  // 任何失敗（逾時、HTTP 錯誤、餘額不足）一律 throw——「降級回原圖」的決策
  // 交給上層（index.ts 的 enhanceResultImage）統一處理，adapter 不自行吞錯。
  // signal 由上層的硬逾時控制，adapter 必須把它傳進所有對外的 fetch。
  enhance(image: Buffer, signal?: AbortSignal): Promise<Buffer>;
}
