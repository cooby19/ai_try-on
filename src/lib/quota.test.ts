// quota.ts 的回歸保護：平台預算、上傳限制與生成限制開關都直接影響成本。
import { afterEach, describe, expect, it, vi } from "vitest";
import { getSupabaseAdmin } from "@/lib/supabase";
import {
  DAILY_GENERATION_LIMIT,
  DAILY_UPLOAD_LIMIT,
  GENERATION_LIMITS_ENABLED,
  PER_PRODUCT_RETRY_LIMIT,
  checkGenerationQuota,
  checkUploadQuota,
  recordTryOnJob,
  todayStartUtcIso,
  updateJobStatus,
} from "@/lib/quota";
import { resolveTryOnConfig } from "@/lib/try-on/config";

vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  PERSON_BUCKET: "person-uploads",
}));

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("生成次數限制", () => {
  it("目前停用，保留原有常數供日後重新啟用", () => {
    expect(GENERATION_LIMITS_ENABLED).toBe(false);
    expect(DAILY_GENERATION_LIMIT).toBe(3);
    expect(PER_PRODUCT_RETRY_LIMIT).toBe(2);
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

  it("停用生成次數限制時，前置檢查不查詢資料庫也不拒絕", async () => {
    const result = await checkGenerationQuota("user-1", "product-a");
    expect(result).toMatchObject({ allowed: true, usedToday: 0, remainingToday: 0 });
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

// ============================================================
// recordTryOnJob：平台預算檢查＋插入的原子入口（migration 20260718010000 的 RPC）。
// 真正的併發防護（advisory lock、鎖內計數）活在 Postgres 函式裡，
// 單元測試無法離線驗證；這裡釘死的是應用層的合約——
// 參數 wiring（時區起點、限制開關）、拒絕文案對應、fail-closed 行為。
// ============================================================
type RpcResult = {
  outcome: "created" | "replayed" | "conflict" | "rejected";
  reject_reason?: "daily" | "product" | "platform";
  used_today: number;
  product_attempts_today: number;
  job?: Record<string, unknown>;
};

const rpcJob = {
  id: "job-new",
  user_id: "user-1",
  product_id: "p-a",
  garment_image_url: "/garments/white-tee.svg",
  provider: "fashn",
  retry_count: 0,
  status: "pending",
  seed: 123,
  config_snapshot: resolveTryOnConfig("fashn", 123).snapshot,
  started_at: "2026-07-04T15:59:59.000Z",
  idempotency_key: null,
  request_fingerprint: null,
  created_at: "2026-07-04T15:59:59.000Z",
  updated_at: "2026-07-04T15:59:59.000Z",
};

function mockRpc(result: { data: RpcResult | null; error: { message: string } | null }) {
  const rpc = vi.fn().mockResolvedValue(result);
  vi.mocked(getSupabaseAdmin).mockReturnValue({
    rpc,
  } as unknown as ReturnType<typeof getSupabaseAdmin>);
  return { rpc };
}

const recordInput = {
  userId: "user-1",
  productId: "p-a",
  personImagePath: "user-1/photo.jpg",
  garmentImageUrl: "/garments/white-tee.svg",
  provider: "fashn",
  costEstimate: 0.075,
  budgetReservation: 0.0775,
  seed: 123,
  configSnapshot: resolveTryOnConfig("fashn", 123).snapshot,
  startedAt: "2026-07-04T15:59:59.000Z",
};

describe("原子插入：參數 wiring", () => {
  it("時區起點與停用生成次數限制的 null 由應用層傳入 RPC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-04T15:59:59Z")); // 台北 23:59:59，今天從 07-03T16:00Z 起算
    const { rpc } = mockRpc({
      data: { outcome: "created", used_today: 1, product_attempts_today: 0, job: rpcJob },
      error: null,
    });
    await recordTryOnJob(recordInput);
    expect(rpc).toHaveBeenCalledWith(
      "insert_try_on_job_within_quota",
      expect.objectContaining({
        p_user_id: "user-1",
        p_product_id: "p-a",
        p_budget_reservation: 0.0775,
        p_since: "2026-07-03T16:00:00.000Z",
        p_daily_limit: null,
        p_product_attempt_limit: null,
      })
    );
  });
});

describe("原子插入：勝出與拒絕", () => {
  it("在限內：回傳 job 與「已含自己」的剩餘次數", async () => {
    mockRpc({
      data: { outcome: "created", used_today: 3, product_attempts_today: 0, job: rpcJob },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("預期 created");
    expect(result.job.id).toBe("job-new");
    expect(result.remainingToday).toBe(0); // 停用時前端不顯示此欄位
  });

  it("每日超限（競態落敗方）：拒絕、回每日上限文案、不回 job", async () => {
    // 併發下兩個請求同過前置檢查，advisory lock 序列化後只有先取得鎖者插入成功；
    // 落敗方拿到 reject_reason = 'daily'，從未插入、零成本。
    mockRpc({
      data: { outcome: "rejected", reject_reason: "daily", used_today: 3, product_attempts_today: 1 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("預期 rejected");
    // 文案必須與前置檢查一字不差（前端與使用者看到一致的訊息）
    expect(result.reason).toContain(`${DAILY_GENERATION_LIMIT} 次`);
    expect(result.reason).toContain("明天");
    expect(result.remainingToday).toBe(0);
  });

  it("每商品超限：拒絕、回每商品上限文案", async () => {
    // 目前兩個上限同為 3，這個分支要靠 DB 端先判 daily 才輪得到；
    // 釘住文案對應本身（reject_reason → reason），未來調整常數時分支仍正確。
    mockRpc({
      data: { outcome: "rejected", reject_reason: "product", used_today: 3, product_attempts_today: 3 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("預期 rejected");
    expect(result.reason).toContain(`${PER_PRODUCT_RETRY_LIMIT} 次`);
    expect(result.reason).toContain("其他商品");
  });

  it("平台預算熔斷：拒絕且不建立可計費 job", async () => {
    mockRpc({
      data: { outcome: "rejected", reject_reason: "platform", used_today: 0, product_attempts_today: 0 },
      error: null,
    });
    const result = await recordTryOnJob(recordInput);
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") throw new Error("預期 rejected");
    expect(result.reason).toContain("平台安全預算");
  });

  it.each(["replayed", "conflict"] as const)("RPC outcome=%s 可被明確區分", async (outcome) => {
    const fingerprint = "a".repeat(64);
    mockRpc({
      data: {
        outcome,
        used_today: 1,
        product_attempts_today: 0,
        job: {
          ...rpcJob,
          idempotency_key: "request-123",
          request_fingerprint: outcome === "conflict" ? "b".repeat(64) : fingerprint,
        },
      },
      error: null,
    });
    const result = await recordTryOnJob({
      ...recordInput,
      idempotencyKey: "request-123",
      requestFingerprint: fingerprint,
    });
    expect(result.outcome).toBe(outcome);
    if (result.outcome === "rejected") throw new Error("不應 rejected");
    expect(result.job.id).toBe("job-new");
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

  it("outcome = created 卻沒有 job：throw（沒有任務列就無法輪詢，也代表函式已被改壞）", async () => {
    mockRpc({
      data: { outcome: "created", used_today: 1, product_attempts_today: 0 },
      error: null,
    });
    await expect(recordTryOnJob(recordInput)).rejects.toThrow(/未回傳任務資料/);
  });

  it("outcome/counter/job runtime shape 任一異常都 fail-closed", async () => {
    mockRpc({
      data: {
        outcome: "created",
        used_today: -1,
        product_attempts_today: 0,
        job: rpcJob,
      },
      error: null,
    });
    await expect(recordTryOnJob(recordInput)).rejects.toThrow(/格式異常/);
  });
});

describe("Job lifecycle 時間與終態冪等", () => {
  function mockStatusUpdate() {
    const terminalIn = vi.fn().mockResolvedValue({ error: null });
    const eq = vi.fn().mockReturnValue({ in: terminalIn, then: undefined });
    const update = vi.fn().mockReturnValue({ eq });
    const from = vi.fn().mockReturnValue({ update });
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as unknown as ReturnType<typeof getSupabaseAdmin>);
    return { update, eq, terminalIn };
  }

  it("provider accepted 寫 provider_submitted_at，但 processing 不寫 completed_at", async () => {
    const database = mockStatusUpdate();
    const eventAt = "2026-07-17T01:00:02.000Z";
    await updateJobStatus(
      "job-1",
      { status: "processing", provider_job_id: "provider-1" },
      eventAt,
    );
    expect(database.update).toHaveBeenCalledWith({
      status: "processing",
      provider_job_id: "provider-1",
      provider_submitted_at: eventAt,
      updated_at: eventAt,
    });
    expect(database.terminalIn).toHaveBeenCalledWith("status", ["pending", "processing"]);
  });

  it.each(["success", "failed"] as const)("%s 寫 completed_at 並只更新非終態", async (status) => {
    const database = mockStatusUpdate();
    const eventAt = "2026-07-17T01:00:03.000Z";
    await updateJobStatus("job-1", { status }, eventAt);
    expect(database.update).toHaveBeenCalledWith(
      expect.objectContaining({ status, completed_at: eventAt, updated_at: eventAt }),
    );
    expect(database.terminalIn).toHaveBeenCalledWith("status", ["pending", "processing"]);
  });

  it("success 清除所有結構化錯誤欄位", async () => {
    const database = mockStatusUpdate();
    await updateJobStatus("job-1", { status: "success", result_image_url: "result.jpg" }, "2026-07-17T01:00:03.000Z");
    expect(database.update).toHaveBeenCalledWith(
      expect.objectContaining({
        error_message: null,
        error_type: null,
        error_code: null,
        provider_http_status: null,
      }),
    );
  });
});
