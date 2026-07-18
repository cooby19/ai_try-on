import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import { checkGenerationQuota } from "@/lib/quota";
import { getDefaultUserModel } from "@/lib/vto";
import { GET } from "./route";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/quota", () => ({
  DAILY_GENERATION_LIMIT: 3,
  GENERATION_LIMITS_ENABLED: false,
  checkGenerationQuota: vi.fn(),
}));
vi.mock("@/lib/vto", () => ({ getDefaultUserModel: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(requireUser).mockResolvedValue({ id: "user-1" } as never);
  vi.mocked(checkGenerationQuota).mockResolvedValue({
    allowed: true,
    usedToday: 0,
    remainingToday: 0,
    productAttemptsToday: 0,
    remainingRetriesForProduct: 0,
  });
  vi.mocked(getDefaultUserModel).mockReturnValue("v1.6");
});

describe("GET /api/quota", () => {
  it("生成次數限制停用時，不回傳剩餘次數而保留模型資訊", async () => {
    const response = await GET(new Request("https://shop.test/api/quota?productId=product-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      generationLimitsEnabled: false,
      defaultModel: "v1.6",
    });
    expect(checkGenerationQuota).toHaveBeenCalledWith("user-1", "product-1");
  });
});
