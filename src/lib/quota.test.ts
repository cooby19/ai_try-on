// quota.ts 的回歸保護：額度規則直接關係 AI API 成本，
// 這裡把「每日上限、每商品重試上限、台北時區邊界」的行為全部釘死，
// 改動額度邏輯時若行為改變，測試必須跟著紅（強迫審視成本影響）。
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  DAILY_GENERATION_LIMIT,
  DAILY_UPLOAD_LIMIT,
  PER_PRODUCT_RETRY_LIMIT,
  checkGenerationQuota,
  checkUploadQuota,
  recordTryOnJob,
  todayStartUtcIso,
} from "@/lib/quota";

// checkGenerationQuota 只依賴 Supabase 的查詢結果（當日 job 列表），
// mock 掉 client 之後，額度判斷本身是純邏輯，可以完整離線測試。
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  PERSON_BUCKET: "person-uploads",
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

// ============================================================
// checkUploadQuota：上傳額度＝統計 person-uploads 該使用者資料夾的當日檔案數。
// 這是額度機制外唯一的成本破口防護（sharp CPU + Storage 無限累積），
// 釘死上限、跨日重置與 fail-closed 行為。
// ============================================================
type StorageFile = { name: string; created_at: string };

const storageFile = (i: number, createdAt: string): StorageFile => ({
  name: `photo-${i}.jpg`,
  created_at: createdAt,
});

// 模擬 storage.from(PERSON_BUCKET).list(userId, options) 查詢鏈，
// 回傳 list mock 以便驗證「只列該使用者資料夾、只取最新上限筆」的 wiring。
function mockStorageList(result: {
  data: StorageFile[] | null;
  error: { message: string } | null;
}) {
  const list = vi.fn().mockResolvedValue(result);
  const from = vi.fn().mockReturnValue({ list });
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    storage: { from },
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { from, list };
}

describe("每日上傳額度", () => {
  it("每日上傳上限 10 次（改這個數字＝改 Storage 成本上界，測試故意寫死以強迫審視）", () => {
    expect(DAILY_UPLOAD_LIMIT).toBe(10);
  });

  it("當日 0 筆：允許", async () => {
    mockStorageList({ data: [], error: null });
    const result = await checkUploadQuota("user-1");
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(0);
  });

  it("當日已用上限 - 1 筆：仍允許最後一次", async () => {
    // 邊界前一格：確認不會提早封鎖
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T02:30:00Z")); // 台北 07-05 10:30
    mockStorageList({
      data: Array.from({ length: DAILY_UPLOAD_LIMIT - 1 }, (_, i) =>
        storageFile(i, "2026-07-05T01:00:00.000Z")
      ),
      error: null,
    });
    const result = await checkUploadQuota("user-1");
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(DAILY_UPLOAD_LIMIT - 1);
  });

  it("當日已達上限：拒絕，reason 為可操作的繁中訊息", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T02:30:00Z"));
    mockStorageList({
      data: Array.from({ length: DAILY_UPLOAD_LIMIT }, (_, i) =>
        storageFile(i, "2026-07-05T01:00:00.000Z")
      ),
      error: null,
    });
    const result = await checkUploadQuota("user-1");
    expect(result.allowed).toBe(false);
    // 訊息必須告訴使用者「明天會恢復」且「已上傳的照片仍可用」，而不是技術性錯誤
    expect(result.reason).toContain(`${DAILY_UPLOAD_LIMIT} 次`);
    expect(result.reason).toContain("明天");
    expect(result.reason).toContain("仍可用");
  });

  it("跨日重置：昨天（台北時區）的上傳不計入今天的額度", async () => {
    // 台北 07-05 00:30（UTC 07-04 16:30）：今天從 07-04T16:00Z 起算，
    // 之前的檔案即使是「UTC 同一天」也屬於台北的昨天，不得計入
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T16:30:00Z"));
    mockStorageList({
      data: [
        ...Array.from({ length: DAILY_UPLOAD_LIMIT - 1 }, (_, i) =>
          storageFile(i, "2026-07-04T15:00:00.000Z") // 台北 07-04 23:00 = 昨天
        ),
        storageFile(99, "2026-07-04T16:10:00.000Z"), // 台北 07-05 00:10 = 今天
      ],
      error: null,
    });
    const result = await checkUploadQuota("user-1");
    expect(result.allowed).toBe(true);
    expect(result.usedToday).toBe(1);
  });

  it("只列該使用者資料夾、只取最新上限筆（判定達標與否不需要翻整個資料夾）", async () => {
    const { from, list } = mockStorageList({ data: [], error: null });
    await checkUploadQuota("user-1");
    expect(from).toHaveBeenCalledWith("person-uploads");
    expect(list).toHaveBeenCalledWith("user-1", {
      limit: DAILY_UPLOAD_LIMIT,
      search: ".jpg",
      sortBy: { column: "created_at", order: "desc" },
    });
  });

  it("Storage 回傳 error 時應 throw，不能默默當成 0 筆放行（fail-closed）", async () => {
    mockStorageList({ data: null, error: { message: "connection refused" } });
    await expect(checkUploadQuota("user-1")).rejects.toThrow(/上傳額度查詢失敗/);
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
// recordTryOnJob：額度檢查＋插入的原子入口（migration 004 的 RPC）。
// 真正的併發防護（advisory lock、鎖內計數）活在 Postgres 函式裡，
// 單元測試無法離線驗證；這裡釘死的是應用層的合約——
// 參數 wiring（時區起點、額度常數）、拒絕文案對應、fail-closed 行為。
// 這些若被改壞，鎖再正確也會算錯「今天」或放行超額請求。
// ============================================================
type RpcResult = {
  allowed: boolean;
  reject_reason?: "daily" | "product" | "source" | "platform";
  used_today: number;
  product_attempts_today: number;
  job?: Record<string, unknown>;
};

const rpcJob = { id: "job-new", retry_count: 0, status: "pending" };

function mockRpc(result: { data: RpcResult | null; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    rpc,
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { rpc };
}

const recordInput = {
  userId: "user-1",
  sourceHash: "a".repeat(64),
  productId: "p-a",
  personImagePath: "user-1/photo.jpg",
  garmentImageUrl: "/garments/white-tee.svg",
  provider: "fashn",
  costEstimate: 0.075,
  budgetReservation: 0.0775,
};

describe("原子插入：參數 wiring", () => {
  it("時區起點與額度常數由應用層傳入 RPC（單一出處在 quota.ts，傳錯 = DB 端算錯額度）", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T15:59:59Z")); // 台北 23:59:59，今天從 07-03T16:00Z 起算
    const { rpc } = mockRpc({
      data: { allowed: true, used_today: 1, product_attempts_today: 0, job: rpcJob },
      error: null,
    });
    await recordTryOnJob(recordInput);
    expect(rpc).toHaveBeenCalledWith(
      "insert_try_on_job_within_quota",
      expect.objectContaining({
        p_user_id: "user-1",
        p_source_hash: "a".repeat(64),
        p_product_id: "p-a",
        p_budget_reservation: 0.0775,
        p_since: "2026-07-03T16:00:00.000Z",
        p_daily_limit: DAILY_GENERATION_LIMIT,
        p_product_attempt_limit: 1 + PER_PRODUCT_RETRY_LIMIT,
      })
    );
  });
});

describe("原子插入：勝出與拒絕", () => {
  it("在限內：回傳 job 與「已含自己」的剩餘次數", async () => {
    mockRpc({
      data: { allowed: true, used_today: 3, product_attempts_today: 0, job: rpcJob },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.allowed).toBe(true);
    expect(result.job?.id).toBe("job-new");
    expect(result.remainingToday).toBe(0); // used_today = 3 = 上限，自己是最後一格
  });

  it("每日超限（競態落敗方）：拒絕、回每日上限文案、不回 job", async () => {
    // 併發下兩個請求同過前置檢查，advisory lock 序列化後只有先取得鎖者插入成功；
    // 落敗方拿到 reject_reason = 'daily'，從未插入、零成本。
    mockRpc({
      data: { allowed: false, reject_reason: "daily", used_today: 3, product_attempts_today: 1 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.allowed).toBe(false);
    expect(result.job).toBeUndefined();
    // 文案必須與前置檢查一字不差（前端與使用者看到一致的訊息）
    expect(result.reason).toContain(`${DAILY_GENERATION_LIMIT} 次`);
    expect(result.reason).toContain("明天");
    expect(result.remainingToday).toBe(0);
  });

  it("每商品超限：拒絕、回每商品上限文案", async () => {
    // 目前兩個上限同為 3，這個分支要靠 DB 端先判 daily 才輪得到；
    // 釘住文案對應本身（reject_reason → reason），未來調整常數時分支仍正確。
    mockRpc({
      data: { allowed: false, reject_reason: "product", used_today: 3, product_attempts_today: 3 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain(`${PER_PRODUCT_RETRY_LIMIT} 次`);
    expect(result.reason).toContain("其他商品");
  });

  it("清 cookie 另建身分仍撞到來源上限：拒絕且不回 job", async () => {
    mockRpc({
      data: { allowed: false, reject_reason: "source", used_today: 0, product_attempts_today: 0 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.allowed).toBe(false);
    expect(result.job).toBeUndefined();
    expect(result.reason).toContain("此網路");
    expect(result.reason).toContain("明天");
  });

  it("平台預算熔斷：拒絕且不建立可計費 job", async () => {
    mockRpc({
      data: { allowed: false, reject_reason: "platform", used_today: 0, product_attempts_today: 0 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("平台安全預算");
  });
});

describe("原子插入：fail-closed", () => {
  it("RPC 回傳 error：throw，不能默默當成功（與額度查詢失敗同一原則）", async () => {
    mockRpc({ data: null, error: { message: "connection refused" } });
    await expect(recordTryOnJob(recordInput)).rejects.toThrow(/建立試穿任務失敗/);
  });

  it("回傳形狀異常（如 migration 004 未執行）：throw，不冒多花錢的風險", async () => {
    // PostgREST 對不存在的函式會回 error，但防禦「函式存在卻被改壞」的情況：
    // data 不是預期形狀時放行 = 額度控管整個失效。
    mockRpc({ data: null, error: null });
    await expect(recordTryOnJob(recordInput)).rejects.toThrow(/格式異常/);
  });

  it("allowed = true 卻沒有 job：throw（沒有任務列就無法輪詢，也代表函式已被改壞）", async () => {
    mockRpc({
      data: { allowed: true, used_today: 1, product_attempts_today: 0 },
      error: null,
    });
    await expect(recordTryOnJob(recordInput)).rejects.toThrow(/未回傳任務資料/);
  });
});
