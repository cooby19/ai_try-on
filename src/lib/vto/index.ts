// Provider factory：依環境變數 VTO_PROVIDER 決定要用哪一家。
// 未來要換供應商（例如 fal.ai），新增一個 adapter 並在這裡註冊即可，
// API route 與前端完全不用改。
import type { VTOProvider } from "./provider";
import type { TryOnModel } from "../types";
import { MockVTOProvider } from "./mock";
import { FashnVTOProvider } from "./fashn";
import { FashnMaxVTOProvider } from "./fashn-max";

const providers: Record<string, () => VTOProvider> = {
  mock: () => new MockVTOProvider(),
  fashn: () => new FashnVTOProvider(),
  // fashn-max：與 fashn 共用同一把 FASHN_API_KEY，用來和 tryon-v1.6 做品質對比
  "fashn-max": () => new FashnMaxVTOProvider(),
};

export function getVTOProvider(name?: string): VTOProvider {
  const key = (name ?? process.env.VTO_PROVIDER ?? "mock").toLowerCase();
  const factory = providers[key];
  if (!factory) {
    throw new Error(`未知的 VTO provider：「${key}」。可用選項：${Object.keys(providers).join(", ")}`);
  }
  return factory();
}

// 使用者可選模型 → provider 名稱的白名單映射。
// 前端傳的是對外名稱（v1.6 / max），不是 provider 內部名稱：
// 這樣前端永遠無法指定白名單以外的 provider（例如注入 mock 產生免費假結果）。
const USER_MODEL_TO_PROVIDER: Record<TryOnModel, string> = {
  "v1.6": "fashn",
  max: "fashn-max",
};

// 環境變數 provider 的預設模型（給前端初始化選擇器用）。
// 回傳 null 代表目前環境不開放選模型（mock 或未知 provider），前端據此隱藏選擇器。
export function getDefaultUserModel(): TryOnModel | null {
  const base = (process.env.VTO_PROVIDER ?? "mock").toLowerCase();
  const entry = (Object.entries(USER_MODEL_TO_PROVIDER) as [TryOnModel, string][]).find(
    ([, providerName]) => providerName === base,
  );
  return entry?.[0] ?? null;
}

// 把使用者選擇的模型解析成 provider 名稱。
// - 環境不開放選模型（如 VTO_PROVIDER=mock）：忽略選擇，一律回環境變數 provider——
//   本機沒有 FASHN key 時前端就算送了 model 也不會打到真實 API。
// - 未傳 model：沿用環境變數 provider（與加入此功能前的行為完全一致，可回滾）。
// - 傳了但不在白名單（含非字串）：回 null，由 route 轉成 400 可操作訊息。
export function resolveVTOProviderName(model?: unknown): string | null {
  const base = (process.env.VTO_PROVIDER ?? "mock").toLowerCase();
  if (getDefaultUserModel() === null) return base;
  if (model === undefined) return base;
  if (typeof model !== "string") return null;
  return USER_MODEL_TO_PROVIDER[model as TryOnModel] ?? null;
}

export type { VTOProvider } from "./provider";
