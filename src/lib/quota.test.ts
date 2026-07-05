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
  verifyJobWithinQuota,
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

// ============================================================
// verifyJobWithinQuota：插入後複驗，併發競態的最後成本防線。
// 前置檢查（SELECT）與插入（INSERT）非原子，並發請求可同時通過檢查；
// 這裡釘死「名次判定、落敗刪列、tie-break 確定性」——這些行為若被改壞，
// 超額 job 會一路走到 provider.submit() 直接花錢。
// ============================================================
type VerifyRow = { id: string; product_id: string; created_at: string };

const vrow = (id: string, productId: string, createdAt: string): VerifyRow => ({
  id,
  product_id: productId,
  created_at: createdAt,
});

// verifyJobWithinQuota 用到三條查詢鏈：
//   select().eq().gte()（重查名次）、delete().eq()（刪落敗列）、update().eq()（修 retry_count）
// 全部 mock 起來，才能驗證「有沒有刪列、有沒有補修正」這些關鍵副作用。
function mockVerifyQuery(opts: {
  rows: VerifyRow[] | null;
  selectError?: { message: string } | null;
  deleteError?: { message: string } | null;
}) {
  const gte = vi
    .fn()
    .mockResolvedValue({ data: opts.rows, error: opts.selectError ?? null });
  const eq = vi.fn().mockReturnValue({ gte });
  const select = vi.fn().mockReturnValue({ eq });
  const deleteEq = vi.fn().mockResolvedValue({ error: opts.deleteError ?? null });
  const deleteFn = vi.fn().mockReturnValue({ eq: deleteEq });
  const updateEq = vi.fn().mockResolvedValue({ error: null });
  const update = vi.fn().mockReturnValue({ eq: updateEq });
  const from = vi.fn().mockReturnValue({ select, delete: deleteFn, update });
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    from,
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, gte, deleteFn, deleteEq, update, updateEq };
}

describe("插入後複驗：名次判定", () => {
  it("名次在上限內：通過，不刪列、retry_count 相符時不多打 update", async () => {
    const { deleteFn, update } = mockVerifyQuery({
      rows: [
        vrow("job-a", "p-a", "2026-07-05T01:00:01.000Z"),
        vrow("job-b", "p-b", "2026-07-05T01:00:02.000Z"),
        vrow("job-me", "p-c", "2026-07-05T01:00:03.000Z"),
      ],
    });
    const result = await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-c",
      retryCount: 0,
    });
    expect(result.allowed).toBe(true);
    expect(result.remainingToday).toBe(0); // 3 筆 = 上限，自己是最後一格
    expect(deleteFn).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("全日名次超限（自己是第 4 筆）：落敗、刪除自己那列、回每日上限文案", async () => {
    // 競態的典型結果：兩個請求都通過了前置檢查（各看到 2 筆），插入後變 4 筆。
    // 較晚插入者名次 = 3（0-based）≥ 每日上限 → 必須在花錢前退出。
    const { deleteEq } = mockVerifyQuery({
      rows: [
        vrow("job-a", "p-1", "2026-07-05T01:00:01.000Z"),
        vrow("job-b", "p-2", "2026-07-05T01:00:02.000Z"),
        vrow("job-c", "p-3", "2026-07-05T01:00:03.000Z"),
        vrow("job-me", "p-4", "2026-07-05T01:00:04.000Z"),
      ],
    });
    const result = await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-4",
      retryCount: 0,
    });
    expect(result.allowed).toBe(false);
    // 文案必須與前置檢查一字不差（前端與使用者看到一致的訊息）
    expect(result.reason).toContain(`${DAILY_GENERATION_LIMIT} 次`);
    expect(result.reason).toContain("明天");
    expect(deleteEq).toHaveBeenCalledWith("id", "job-me");
    expect(result.remainingToday).toBe(0);
  });

  it("同商品 4 筆：拒絕（目前常數下由每日上限先攔截，同 checkGenerationQuota 的既有註記）", async () => {
    // 同商品名次 ≤ 全日名次，且兩個上限目前同為 3，每商品分支實際被每日分支先攔截。
    // 釘死對外行為（拒絕 + 刪列）；未來調高每日上限時，這個測試提醒重看訊息分支。
    const { deleteEq } = mockVerifyQuery({
      rows: [
        vrow("job-a", "p-a", "2026-07-05T01:00:01.000Z"),
        vrow("job-b", "p-a", "2026-07-05T01:00:02.000Z"),
        vrow("job-c", "p-a", "2026-07-05T01:00:03.000Z"),
        vrow("job-me", "p-a", "2026-07-05T01:00:04.000Z"),
      ],
    });
    const result = await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-a",
      retryCount: 3,
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeTruthy();
    expect(deleteEq).toHaveBeenCalledWith("id", "job-me");
  });
});

describe("插入後複驗：tie-break 確定性", () => {
  // created_at 同毫秒時勝負由 id 決定。這兩個測試互為鏡像：
  // 同一組資料，兩個並發請求必須算出「恰好一勝一敗」，
  // 否則會兩敗俱傷（都退出）或兩邊都花錢（競態沒修到）。
  // rows 刻意亂序傳入，順便釘住「名次來自程式內排序，不依賴查詢回傳順序」。
  const tiedRows = [
    vrow("job-z", "p-d", "2026-07-05T01:00:03.000Z"),
    vrow("job-b", "p-b", "2026-07-05T01:00:02.000Z"),
    vrow("job-m", "p-c", "2026-07-05T01:00:03.000Z"),
    vrow("job-a", "p-a", "2026-07-05T01:00:01.000Z"),
  ];

  it("同毫秒插入：id 較小者勝出", async () => {
    const { deleteFn } = mockVerifyQuery({ rows: tiedRows });
    const result = await verifyJobWithinQuota({
      jobId: "job-m",
      userId: "user-1",
      productId: "p-c",
      retryCount: 0,
    });
    expect(result.allowed).toBe(true);
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("同毫秒插入：id 較大者落敗、被刪列", async () => {
    const { deleteEq } = mockVerifyQuery({ rows: tiedRows });
    const result = await verifyJobWithinQuota({
      jobId: "job-z",
      userId: "user-1",
      productId: "p-d",
      retryCount: 0,
    });
    expect(result.allowed).toBe(false);
    expect(deleteEq).toHaveBeenCalledWith("id", "job-z");
  });
});

describe("插入後複驗：防禦性行為", () => {
  it("刪除失敗：不 throw、仍回 not allowed（寧可多扣一格額度，不冒多花錢的風險）", async () => {
    const rows = [
      vrow("job-a", "p-1", "2026-07-05T01:00:01.000Z"),
      vrow("job-b", "p-2", "2026-07-05T01:00:02.000Z"),
      vrow("job-c", "p-3", "2026-07-05T01:00:03.000Z"),
      vrow("job-me", "p-4", "2026-07-05T01:00:04.000Z"),
    ];
    mockVerifyQuery({ rows, deleteError: { message: "delete failed" } });
    const result = await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-4",
      retryCount: 0,
    });
    expect(result.allowed).toBe(false);
  });

  it("重查結果找不到自己剛插入的列：fail-closed 視為落敗", async () => {
    // 理論上不會發生（INSERT 已提交才會走到這裡）；若真發生代表計數不可信，
    // 安全方向是拒絕（多扣），而不是放行（可能多花錢）。
    const { deleteEq } = mockVerifyQuery({
      rows: [vrow("job-a", "p-a", "2026-07-05T01:00:01.000Z")],
    });
    const result = await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-a",
      retryCount: 0,
    });
    expect(result.allowed).toBe(false);
    expect(deleteEq).toHaveBeenCalledWith("id", "job-me");
  });

  it("複驗查詢失敗：throw，不能默默放行（與前置檢查同一原則）", async () => {
    mockVerifyQuery({ rows: null, selectError: { message: "connection refused" } });
    await expect(
      verifyJobWithinQuota({
        jobId: "job-me",
        userId: "user-1",
        productId: "p-a",
        retryCount: 0,
      })
    ).rejects.toThrow(/額度驗證失敗/);
  });
});

describe("插入後複驗：retry_count 修正", () => {
  it("複驗名次與插入時的 retry_count 不符：補一次 update 修正", async () => {
    // 競態場景：兩個同商品請求都在前置檢查看到 1 筆 → 都拿 productAttemptsToday = 1。
    // 勝出者的實際名次是 2，不修正的話 retry_count 會污染成本統計。
    const { update, updateEq } = mockVerifyQuery({
      rows: [
        vrow("job-a", "p-a", "2026-07-05T01:00:01.000Z"),
        vrow("job-b", "p-a", "2026-07-05T01:00:02.000Z"),
        vrow("job-me", "p-a", "2026-07-05T01:00:03.000Z"),
      ],
    });
    const result = await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-a",
      retryCount: 1,
    });
    expect(result.allowed).toBe(true);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ retry_count: 2 })
    );
    expect(updateEq).toHaveBeenCalledWith("id", "job-me");
  });
});

describe("插入後複驗：台北時區 wiring", () => {
  it("複驗與前置檢查用同一個「今天的起點」過濾 created_at", async () => {
    // 兩段檢查若時區邊界不一致，跨日交界的請求會被算進不同的「今天」，
    // 名次判定就會失真。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T15:59:59Z"));
    const { gte } = mockVerifyQuery({
      rows: [vrow("job-me", "p-a", "2026-07-04T10:00:00.000Z")],
    });
    await verifyJobWithinQuota({
      jobId: "job-me",
      userId: "user-1",
      productId: "p-a",
      retryCount: 0,
    });
    expect(gte).toHaveBeenCalledWith("created_at", "2026-07-03T16:00:00.000Z");
  });
});
