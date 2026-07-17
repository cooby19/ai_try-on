import "server-only";

import { timingSafeEqual } from "crypto";
import { getSupabaseAdmin } from "./supabase";

export interface NotificationRow {
  id: string;
  recipient_email: string;
  template: NotificationTemplate;
  payload: Record<string, unknown>;
  attempt_count: number;
}

export type NotificationDeliveryMode = "email" | "record_only";

type NotificationTemplate =
  | "order_created"
  | "order_status_changed"
  | "cancellation_requested"
  | "refund_requested"
  | "refund_updated"
  | "support_ticket_created"
  | "support_reply"
  | "security_alert";

export function verifyInternalSecret(authorization: string | null): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 32 || !authorization?.startsWith("Bearer ")) return false;
  const actual = authorization.slice(7);
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

/**
 * 未設定完整 Resend 憑證時，測試環境仍保留通知與稽核軌跡，但不嘗試寄送。
 * 兩個設定必須同時存在，避免半套設定造成對外請求或不明確的失敗狀態。
 */
export function getNotificationDeliveryMode(): NotificationDeliveryMode {
  return process.env.RESEND_API_KEY?.trim() && process.env.EMAIL_FROM?.trim()
    ? "email"
    : "record_only";
}

export function renderNotification(template: NotificationTemplate, payload: Record<string, unknown>): { subject: string; html: string } {
  const orderNumber = safeText(payload.orderNumber, "訂單");
  const ticketNumber = safeText(payload.ticketNumber, "客服案件");
  const status = safeText(payload.status, "已更新");
  const content: Record<NotificationTemplate, { subject: string; heading: string; message: string }> = {
    order_created: { subject: `訂單 ${orderNumber} 已成立`, heading: "訂單已成立", message: `我們已收到 ${orderNumber}，請依頁面指示完成付款。` },
    order_status_changed: { subject: `訂單 ${orderNumber} 狀態更新`, heading: "訂單狀態已更新", message: `${orderNumber} 的最新狀態為「${statusLabel(status)}」。` },
    cancellation_requested: { subject: `訂單 ${orderNumber} 取消申請已收到`, heading: "取消申請已收到", message: "營運人員將確認出貨與付款狀態，完成後會再次通知你。" },
    refund_requested: { subject: `訂單 ${orderNumber} 退款申請已收到`, heading: "退款申請已收到", message: "我們已保存申請與原因，營運人員將進行審核。" },
    refund_updated: { subject: `訂單 ${orderNumber} 退款進度更新`, heading: "退款進度已更新", message: `目前狀態為「${refundStatusLabel(status)}」。` },
    support_ticket_created: { subject: `${ticketNumber} 已建立`, heading: "客服案件已建立", message: `我們已收到「${safeText(payload.subject, "客服問題")}」，後續回覆會寄送通知。` },
    support_reply: { subject: `${ticketNumber} 有新回覆`, heading: "客服已回覆", message: `你的客服案件「${safeText(payload.subject, "客服問題")}」有新進度，請登入客服中心查看。` },
    security_alert: { subject: "帳戶安全通知", heading: "偵測到需要留意的活動", message: "若這不是你的操作，請立即聯絡客服並重新登入帳戶。" },
  };
  const selected = content[template];
  const baseUrl = safeUrl(process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000");
  return {
    subject: selected.subject,
    html: `<!doctype html><html lang="zh-Hant"><body style="font-family:Arial,sans-serif;color:#292524;line-height:1.6"><div style="max-width:560px;margin:32px auto;padding:24px;border:1px solid #e7e5e4;border-radius:12px"><h1 style="font-size:22px">${selected.heading}</h1><p>${selected.message}</p><p><a href="${baseUrl}" style="color:#1d4ed8">前往樣衣間查看</a></p><p style="margin-top:28px;color:#78716c;font-size:12px">這是系統通知，請勿直接回覆。需要協助請使用客服中心。</p></div></body></html>`,
  };
}

export async function dispatchNotifications(limit = 20): Promise<{ claimed: number; sent: number; skipped: number; failed: number }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("claim_notification_batch", { p_limit: limit });
  if (error) throw new Error(`通知佇列鎖定失敗：${error.message}`);
  const rows = (data ?? []) as NotificationRow[];
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  const deliveryMode = getNotificationDeliveryMode();
  for (const row of rows) {
    try {
      if (deliveryMode === "record_only") {
        const { error: updateError } = await supabase.from("notification_outbox").update({
          status: "skipped",
          skipped_at: new Date().toISOString(),
          locked_at: null,
          last_error: "測試模式：尚未設定 RESEND_API_KEY 與 EMAIL_FROM，未實際寄送。",
        }).eq("id", row.id).eq("status", "sending");
        if (updateError) throw updateError;
        skipped += 1;
        continue;
      }
      const content = renderNotification(row.template, row.payload ?? {});
      await sendEmail(row.recipient_email, content.subject, content.html);
      const { error: updateError } = await supabase.from("notification_outbox").update({
        status: "sent", sent_at: new Date().toISOString(), locked_at: null, last_error: null,
      }).eq("id", row.id).eq("status", "sending");
      if (updateError) throw updateError;
      sent += 1;
    } catch (cause) {
      const attempts = row.attempt_count;
      const dead = attempts >= 5;
      const availableAt = new Date(Date.now() + Math.min(2 ** attempts * 60_000, 6 * 60 * 60 * 1000)).toISOString();
      await supabase.from("notification_outbox").update({
        status: dead ? "dead" : "failed",
        available_at: availableAt,
        locked_at: null,
        last_error: cause instanceof Error ? cause.message.slice(0, 1000) : "寄送失敗",
      }).eq("id", row.id);
      failed += 1;
    }
  }
  return { claimed: rows.length, sent, skipped, failed };
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("尚未設定 RESEND_API_KEY 或 EMAIL_FROM。");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [to], subject, html }),
  });
  if (!response.ok) throw new Error(`Email provider 回傳 HTTP ${response.status}。`);
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  return String(value).slice(0, 200).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.hostname === "localhost" ? url.origin : "https://example.invalid";
  } catch {
    return "https://example.invalid";
  }
}

function statusLabel(status: string): string {
  return ({ pending_payment: "待付款", processing: "處理中", payment_failed: "付款失敗", cancellation_requested: "取消審核中", cancelled: "已取消", shipped: "已出貨", completed: "已完成", refund_pending: "退款處理中", partially_refunded: "部分退款", refunded: "已退款", expired: "已逾期" } as Record<string, string>)[status] ?? status;
}

function refundStatusLabel(status: string): string {
  return ({ requested: "待審核", reviewing: "審核中", approved: "已核准", processing: "處理中", succeeded: "已完成", rejected: "未通過", failed: "處理失敗", cancelled: "已撤回" } as Record<string, string>)[status] ?? status;
}
