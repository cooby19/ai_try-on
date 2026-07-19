import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import { checkGenerationQuota } from "@/lib/quota";
import { getDefaultUserModel } from "@/lib/vto";
import { GET } from "./route";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/quota", () => ({
  DAILY_GENERATION_LIMIT: 3,
  GENERATION_LIMITS_ENABLED: true,
  checkGenerationQuota: vi.fn(),
}));
vi.mock("@/lib/vto", () => ({ getDefaultUserModel: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(checkGenerationQuota).mockResolvedValue({
    allowed: true,
    isUnlimited: false,
    usedToday: 0,
    remainingToday: 0,
    productAttemptsToday: 0,
    remainingRetriesForProduct: 0,
  });
  vi.mocked(getDefaultUserModel).mockReturnValue("v1.6");
});

describe("GET /api/quota", () => {
  it("一般會員回傳每日與單一商品的剩餘額度", async () => {
    const response = await GET(new Request("https://shop.test/api/quota?productId=product-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generationLimitsEnabled: true,
      unlimitedGeneration: false,
      remainingToday: 0,
      remainingRetriesForProduct: 0,
      dailyLimit: 3,
      defaultModel: "v1.6",
    });
    expect(checkGenerationQuota).toHaveBeenCalledWith("user-1", "product-1");
  });

  it("admin 不回傳可用次數，讓前端保持可重新生成", async () => {
    vi.mocked(checkGenerationQuota).mockResolvedValue({
      allowed: true,
      isUnlimited: true,
      usedToday: 10,
      remainingToday: 0,
      productAttemptsToday: 10,
      remainingRetriesForProduct: 0,
    });

    const response = await GET(new Request("https://shop.test/api/quota?productId=product-1"));

    expect(await response.json()).toEqual({
      generationLimitsEnabled: false,
      unlimitedGeneration: true,
      defaultModel: "v1.6",
    });
  });
});
