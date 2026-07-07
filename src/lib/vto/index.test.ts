// resolveVTOProviderName / getDefaultUserModel 的白名單邊界測試。
// 為什麼測這些：模型選擇是「前端傳值 → 後端白名單映射」的安全邊界，
// 一旦放寬（例如直接把使用者輸入丟進 getVTOProvider），前端就能注入 mock
// 產生免費假結果、或在 mock 環境誤打真實 API。完全離線，不碰任何外部服務。
import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveVTOProviderName, getDefaultUserModel } from "./index";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("VTO_PROVIDER=mock（本機無 API key 的預設環境）", () => {
  it("忽略前端選擇，一律回 mock——避免沒有 key 的環境誤打真實 API", () => {
    vi.stubEnv("VTO_PROVIDER", "mock");
    expect(resolveVTOProviderName(undefined)).toBe("mock");
    expect(resolveVTOProviderName("v1.6")).toBe("mock");
    expect(resolveVTOProviderName("max")).toBe("mock");
    // 就算是垃圾值也回 mock 而不是 null：mock 模式下選擇本來就無效，不該回 400 擋使用者
    expect(resolveVTOProviderName("garbage")).toBe("mock");
  });

  it("預設模型為 null——前端據此隱藏選擇器", () => {
    vi.stubEnv("VTO_PROVIDER", "mock");
    expect(getDefaultUserModel()).toBeNull();
  });

  it("未設定 VTO_PROVIDER 時視同 mock（與 getVTOProvider 的預設一致）", () => {
    vi.stubEnv("VTO_PROVIDER", undefined as unknown as string); // 模擬變數不存在
    expect(resolveVTOProviderName("max")).toBe("mock");
    expect(getDefaultUserModel()).toBeNull();
  });
});

describe("VTO_PROVIDER=fashn（正式環境預設 v1.6）", () => {
  it("未傳 model 沿用環境變數——與加入選模功能前的行為一致（可回滾）", () => {
    vi.stubEnv("VTO_PROVIDER", "fashn");
    expect(resolveVTOProviderName(undefined)).toBe("fashn");
  });

  it("白名單映射：v1.6 → fashn、max → fashn-max", () => {
    vi.stubEnv("VTO_PROVIDER", "fashn");
    expect(resolveVTOProviderName("v1.6")).toBe("fashn");
    expect(resolveVTOProviderName("max")).toBe("fashn-max");
  });

  it("白名單以外的值回 null（route 轉 400）——含直接注入 provider 內部名稱", () => {
    vi.stubEnv("VTO_PROVIDER", "fashn");
    // 不能讓前端用內部名稱繞過白名單（mock 免費假結果、fashn-max 該走 "max"）
    expect(resolveVTOProviderName("mock")).toBeNull();
    expect(resolveVTOProviderName("fashn")).toBeNull();
    expect(resolveVTOProviderName("fashn-max")).toBeNull();
    expect(resolveVTOProviderName("")).toBeNull();
    // 非字串（惡意 JSON body）也要擋下，不能丟進映射表當 key
    expect(resolveVTOProviderName(123)).toBeNull();
    expect(resolveVTOProviderName({ model: "max" })).toBeNull();
    expect(resolveVTOProviderName(null)).toBeNull();
  });

  it("預設模型為 v1.6", () => {
    vi.stubEnv("VTO_PROVIDER", "fashn");
    expect(getDefaultUserModel()).toBe("v1.6");
  });
});

describe("VTO_PROVIDER=fashn-max（管理者把 Max 設為環境預設）", () => {
  it("未傳 model 沿用 fashn-max；預設模型回報 max 讓選擇器初始值一致", () => {
    vi.stubEnv("VTO_PROVIDER", "fashn-max");
    expect(resolveVTOProviderName(undefined)).toBe("fashn-max");
    expect(getDefaultUserModel()).toBe("max");
  });

  it("使用者仍可改選 v1.6", () => {
    vi.stubEnv("VTO_PROVIDER", "fashn-max");
    expect(resolveVTOProviderName("v1.6")).toBe("fashn");
  });
});
