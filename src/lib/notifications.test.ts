import { afterEach, describe, expect, it, vi } from "vitest";
import { dispatchNotifications, getNotificationDeliveryMode, renderNotification, verifyInternalSecret } from "./notifications";

vi.mock("server-only", () => ({}));

const { getSupabaseAdminMock } = vi.hoisted(() => ({ getSupabaseAdminMock: vi.fn() }));
vi.mock("./supabase", () => ({ getSupabaseAdmin: getSupabaseAdminMock }));

describe("營運通知", () => {
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.RESEND_API_KEY;
    delete process.env.EMAIL_FROM;
  });

  it("轉義外部 payload，避免 Email HTML 注入", () => {
    const result = renderNotification("support_reply", { ticketNumber: "TKT-1", subject: "<script>alert(1)</script>" });
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).not.toContain("<script>");
  });

  it("以定值時間比較 cron secret，且拒絕短 secret", () => {
    process.env.CRON_SECRET = "a".repeat(32);
    expect(verifyInternalSecret(`Bearer ${"a".repeat(32)}`)).toBe(true);
    expect(verifyInternalSecret(`Bearer ${"b".repeat(32)}`)).toBe(false);
    process.env.CRON_SECRET = "short";
    expect(verifyInternalSecret("Bearer short")).toBe(false);
  });

  it("未設定完整 Resend 憑證時，使用只記錄通知的測試模式", () => {
    expect(getNotificationDeliveryMode()).toBe("record_only");
    process.env.RESEND_API_KEY = "re_test";
    expect(getNotificationDeliveryMode()).toBe("record_only");
    process.env.EMAIL_FROM = "樣衣間 <no-reply@example.com>";
    expect(getNotificationDeliveryMode()).toBe("email");
  });

  it("測試模式將通知標記為 skipped，不呼叫 Email provider 或建立失敗重試", async () => {
    const statusCheck = vi.fn().mockResolvedValue({ error: null });
    const idCheck = vi.fn(() => ({ eq: statusCheck }));
    const update = vi.fn(() => ({ eq: idCheck }));
    const rpc = vi.fn().mockResolvedValue({
      data: [{ id: "notification-1", recipient_email: "tester@example.com", template: "order_created", payload: {}, attempt_count: 1 }],
      error: null,
    });
    getSupabaseAdminMock.mockReturnValue({ rpc, from: vi.fn(() => ({ update })) });

    await expect(dispatchNotifications()).resolves.toEqual({ claimed: 1, sent: 0, skipped: 1, failed: 0 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({
      status: "skipped",
      last_error: expect.stringContaining("測試模式"),
    }));
    expect(statusCheck).toHaveBeenCalledWith("status", "sending");
  });
});
