// Provider factory：依環境變數 VTO_PROVIDER 決定要用哪一家。
// 未來要換供應商（例如 fal.ai），新增一個 adapter 並在這裡註冊即可，
// API route 與前端完全不用改。
import type { VTOProvider } from "./provider";
import { MockVTOProvider } from "./mock";
import { FashnVTOProvider } from "./fashn";

const providers: Record<string, () => VTOProvider> = {
  mock: () => new MockVTOProvider(),
  fashn: () => new FashnVTOProvider(),
};

export function getVTOProvider(name?: string): VTOProvider {
  const key = (name ?? process.env.VTO_PROVIDER ?? "mock").toLowerCase();
  const factory = providers[key];
  if (!factory) {
    throw new Error(`未知的 VTO provider：「${key}」。可用選項：${Object.keys(providers).join(", ")}`);
  }
  return factory();
}

export type { VTOProvider } from "./provider";
