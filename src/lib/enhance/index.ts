// Enhance factory + 降級策略（比照 src/lib/vto/index.ts 的 provider factory 模式）。
// route 只呼叫 enhanceResultImage()：要不要放大、放大失敗怎麼辦，全部在這一層決定。
import type { ImageEnhancer } from "./enhancer";
import { RealEsrganEnhancer } from "./realesrgan";

// enhance 呼叫的硬逾時：總延遲必須留在前端 120 秒輪詢上限內
// （v1.6 quality 生成約 12–17 秒 + 放大 ≤30 秒，最壞約 50 秒，餘裕充足）。
// Replicate 冷啟動偶爾會超過這個上限——會被中止並降級回原圖，不影響成功率。
export const ENHANCE_TIMEOUT_MS = 30_000;

const enhancers: Record<string, () => ImageEnhancer> = {
  realesrgan: () => new RealEsrganEnhancer(),
};

// 只有這些 VTO provider 的結果需要放大：fashn（tryon-v1.6）原生固定 864×1296，
// 有解析度缺口；fashn-max 原生就能出高解析度、mock 是假示範圖，放大只是白花錢。
const ENHANCE_TARGET_VTO_PROVIDERS = new Set(["fashn"]);

// ENHANCE_PROVIDER 預設 none = 完全停用，行為與加入此功能前完全一致（可直接回滾）。
// 未知值回 null + 警告而非 throw：enhance 是選配後處理，環境變數打錯字
// 不該讓已扣額度的生成整筆報廢——與下方「放大失敗 = 降級不失敗」同一精神。
export function getImageEnhancer(): ImageEnhancer | null {
  const key = (process.env.ENHANCE_PROVIDER ?? "none").toLowerCase();
  if (key === "none") return null;
  const factory = enhancers[key];
  if (!factory) {
    console.warn(
      `未知的 ENHANCE_PROVIDER：「${key}」，放大功能停用。可用選項：none, ${Object.keys(enhancers).join(", ")}`
    );
    return null;
  }
  return factory();
}

// job 建立前預留「可能發生」的放大成本，讓平台預算熔斷涵蓋 Replicate，
// 而 job.cost_estimate 仍只在真的放大成功後才增加，保留實際成本語意。
export function getEnhancementCostEstimate(vtoProviderName: string): number {
  if (!ENHANCE_TARGET_VTO_PROVIDERS.has(vtoProviderName)) return 0;
  return getImageEnhancer()?.costEstimate ?? 0;
}

export interface EnhanceOutcome {
  image: Buffer; // 要存進 bucket 的圖：放大成功是放大圖；停用／跳過／失敗都是原圖
  enhanced: boolean; // 是否真的執行了放大（true 時才把 extraCost 計入 job.cost_estimate）
  extraCost: number; // 本次放大的預估成本（USD）；未放大為 0
}

// 對 VTO 結果圖做放大後處理（route 在存入 try-on-results bucket 之前呼叫）。
//
// 失敗策略：任何 enhance 錯誤（逾時、4xx/5xx、餘額不足）一律 log 後回原圖、
// 不往外 throw——走到這裡代表 VTO 生成已成功、使用者已扣額度，
// 不能因為選配的後處理讓整次生成報廢，job 仍照常標 success。
export async function enhanceResultImage(
  image: Buffer,
  vtoProviderName: string
): Promise<EnhanceOutcome> {
  const skip: EnhanceOutcome = { image, enhanced: false, extraCost: 0 };
  if (!ENHANCE_TARGET_VTO_PROVIDERS.has(vtoProviderName)) return skip;
  const enhancer = getImageEnhancer();
  if (!enhancer) return skip;

  // 硬逾時用 AbortController 真正中止底層 fetch（signal 傳進 adapter 的所有對外請求），
  // 不讓輪詢 route 掛在慢速外部 API 上空等。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ENHANCE_TIMEOUT_MS);
  try {
    const enhanced = await enhancer.enhance(image, controller.signal);
    return { image: enhanced, enhanced: true, extraCost: enhancer.costEstimate };
  } catch (e) {
    console.error(`結果圖放大失敗（${enhancer.enhancerName}），降級使用原圖：`, e);
    return skip;
  } finally {
    clearTimeout(timer);
  }
}
