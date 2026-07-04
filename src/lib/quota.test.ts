// quota.ts 的回歸保護：額度規則直接關係 AI API 成本，
// 這裡把「每日上限、每商品重試上限、台北時區邊界」的行為全部釘死，
// 改動額度邏輯時若行為改變，測試必須跟著紅（強迫審視成本影響）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  DAILY_GENERATION_LIMIT,
  PER_PRODUCT_RETRY_LIMIT,
  checkGenerationQuota,
  todayStartUtcIso,
} from "@/lib/quota";

// checkGenerationQuota 只依賴 Supabase 的查詢結果（當日 job 列表），
// mock 掉 client 之後，額度判斷本身是純邏輯，可以完整離線測試。
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
}));

type JobRow = { id: string; product_id: string };

const job = (productId: string, i: number): JobRow => ({
  id: `job-${i}`,
  product_id: productId,
});

// 模擬 from("try_on_jobs").select(...).eq(...).gte(...) 查詢鏈，
// 回傳 gte mock 以便驗證「當日起點」時間字串（時區邊界的 wiring 測試）。
function mockJobsQuery(result: {
  data: JobRow[] | null;
  error: { message: string } | null;
}) {
  const gte = vi.fn().mockResolvedValue(result);
  const eq = vi.fn().mockReturnValue({ gte });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, select, eq, gte };
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("額度常數", () => {
  it("每日 3 次、每商品重試 2 次（改這兩個數字＝改成本上限，測試故意寫死以強迫審視）", () => {
    expect(DAILY_GENERATION_LIMIT).toBe(3);
    expect(PER_PRODUCT_RETRY_LIMIT).toBe(2);
  });
});

describe("每日總額度邊界", () => {
  it("當日 0 筆：允許，剩餘次數 = 每日上限", async () => {
    mockJobsQuery({ data: [], error: null });
    const result = await checkGenerationQuota("user-1", "product-a");
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(0);
    expect(result.remainingToday).toBe(DAILY_GENERATION_LIMIT);
  });

  it("當日已用上限 - 1 筆：仍允許最後一次", async () => {
    // 邊界前一格：確認不會提早封鎖（少算額度＝壞體驗，多算＝成本破口）
    mockJobsQuery({
      data: [job("product-a", 1), job("product-b", 2)],
      error: null,
    });
    const result = await checkGenerationQuota("user-1", "product-c");
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(2);
    expect(result.remainingToday).toBe(1);
  });

  it("當日已達上限：拒絕，reason 為可操作的繁中訊息", async () => {
    mockJobsQuery({
      data: [job("product-a", 1), job("product-b", 2), job("product-c", 3)],
      error: null,
    });
    const result = await checkGenerationQuota("user-1", "product-d");
    expect(result.allowed).toBe(false);
    expect(result.remainingToday).toBe(0);
    // 訊息必須告訴使用者「明天會恢復」，而不是技術性錯誤
    expect(result.reason).toContain(`${DAILY_GENERATION_LIMIT} 次`);
    expect(result.reason).toContain("明天");
  });

  it("當日筆數異常超過上限：剩餘次數不得為負數", async () => {
    // 防禦性邊界：資料異常（例如手動補資料）時，回傳給前端的數字仍要合理
    mockJobsQuery({
      data: [1, 2, 3, 4, 5].map((i) => job(`product-${i}`, i)),
      error: null,
    });
    const result = await checkGenerationQuota("user-1", "product-a");
    expect(result.allowed).toBe(false);
    expect(result.remainingToday).toBe(0);
    expect(result.remainingRetriesForProduct).toBeGreaterThanOrEqual(0);
  });
});

describe("每商品重試上限", () => {
  it("同商品已 2 筆（首次 + 1 次重試）：第 3 次仍允許", async () => {
    mockJobsQuery({
      data: [job("product-a", 1), job("product-a", 2)],
      error: null,
    });
    const result = await checkGenerationQuota("user-1", "product-a");
    expect(result.allowed).toBe(true);
    // productAttemptsToday 會直接當成新 job 的 retry_count，算錯會污染成本統計
    expect(result.productAttemptsToday).toBe(2);
    expect(result.remainingRetriesForProduct).toBe(1);
  });

  it("不同商品不互相占用重試額度，但共同計入每日上限", async () => {
    mockJobsQuery({
      data: [job("product-a", 1), job("product-a", 2)],
      error: null,
    });
    const result = await checkGenerationQuota("user-1", "product-b");
    expect(result.allowed).toBe(true);
    expect(result.productAttemptsToday).toBe(0);
    expect(result.remainingRetriesForProduct).toBe(1 + PER_PRODUCT_RETRY_LIMIT);
    // 每日額度仍被其他商品的 2 筆占用
    expect(result.remainingToday).toBe(DAILY_GENERATION_LIMIT - 2);
  });

  it("同商品已 3 筆：拒絕（目前常數下由每日上限先觸發）", async () => {
    // 同商品次數 ≤ 當日總次數，且兩個上限目前同為 3，
    // 所以「每商品上限」的訊息分支實際上被「每日上限」先攔截。
    // 這裡釘死的是對外行為（拒絕 + 重試餘額歸零）；
    // 若未來調高每日上限，這個測試會提醒重新檢視每商品訊息分支。
    mockJobsQuery({
      data: [job("product-a", 1), job("product-a", 2), job("product-a", 3)],
      error: null,
    });
    const result = await checkGenerationQuota("user-1", "product-a");
    expect(result.allowed).toBe(false);
    expect(result.productAttemptsToday).toBe(3);
    expect(result.remainingRetriesForProduct).toBe(0);
    expect(result.reason).toBeTruthy();
  });
});

describe("台北時區（UTC+8）每日邊界", () => {
  it("UTC 15:59:59（台北 23:59:59）仍屬於「今天」，起點為前一天 16:00 UTC", () => {
    // 時區換算最容易錯的一格：UTC 日期已是 07-04，但台北的「今天」從 07-03T16:00Z 開始
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T15:59:59Z"));
    expect(todayStartUtcIso()).toBe("2026-07-03T16:00:00.000Z");
  });

  it("UTC 16:00:00 整（台北隔日 00:00）起算新的一天", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T16:00:00Z"));
    expect(todayStartUtcIso()).toBe("2026-07-04T16:00:00.000Z");
  });

  it("UTC 上午（台北同日白天）：起點為前一天 16:00 UTC", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T02:30:00Z")); // 台北 07-05 10:30
    expect(todayStartUtcIso()).toBe("2026-07-04T16:00:00.000Z");
  });

  it("checkGenerationQuota 用「今天的起點」過濾 created_at", async () => {
    // wiring 測試：確認額度查詢真的用台北時區邊界過濾，而不是 UTC 或本機時區
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T15:59:59Z"));
    const { gte } = mockJobsQuery({ data: [], error: null });
    await checkGenerationQuota("user-1", "product-a");
    expect(gte).toHaveBeenCalledWith("created_at", "2026-07-03T16:00:00.000Z");
  });
});

describe("查詢失敗", () => {
  it("Supabase 回傳 error 時應 throw，不能默默當成 0 筆放行", async () => {
    // 若查詢失敗被當成「沒用過額度」，資料庫故障期間額度控管會整個失效
    mockJobsQuery({ data: null, error: { message: "connection refused" } });
    await expect(checkGenerationQuota("user-1", "product-a")).rejects.toThrow(
      /額度查詢失敗/
    );
  });
});
