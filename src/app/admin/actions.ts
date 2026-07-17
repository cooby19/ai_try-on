"use server";

import { revalidatePath } from "next/cache";
import { getSupabaseAdmin } from "@/lib/supabase";
import { requireStaff } from "@/lib/staff";

export async function reviewRefundAction(formData: FormData) {
  const actor = await requireStaff(["admin", "operations"]);
  const requestId = String(formData.get("requestId") ?? "");
  const action = String(formData.get("action") ?? "");
  const allowed = new Set(["approve", "reject", "mark_processing", "mark_succeeded", "mark_failed"]);
  if (!allowed.has(action)) throw new Error("退款操作不正確。");
  const amountText = String(formData.get("approvedAmount") ?? "").trim();
  const amount = amountText ? Number(amountText) : null;
  if (amount !== null && (!Number.isFinite(amount) || amount < 0)) throw new Error("核准金額不正確。");
  const { data, error } = await getSupabaseAdmin().rpc("review_refund_request", {
    p_actor_user_id: actor.id,
    p_request_id: requestId,
    p_action: action,
    p_approved_amount: amount,
    p_note: String(formData.get("note") ?? "").trim() || null,
    p_provider_refund_id: String(formData.get("providerRefundId") ?? "").trim() || null,
  });
  if (error || (data as { status?: string } | null)?.status !== "success") throw new Error(`退款操作失敗：${error?.message ?? (data as { status?: string } | null)?.status ?? "未知錯誤"}`);
  revalidatePath("/admin");
}

export async function replySupportAction(formData: FormData) {
  const actor = await requireStaff(["admin", "operations", "support"]);
  const ticketId = String(formData.get("ticketId") ?? "");
  const message = String(formData.get("message") ?? "").trim();
  const status = String(formData.get("status") ?? "in_progress");
  if (!message || message.length > 5000) throw new Error("回覆須為 1–5000 字。");
  if (!["open", "waiting_customer", "in_progress", "resolved", "closed"].includes(status)) throw new Error("客服狀態不正確。");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("support_messages").insert({ ticket_id: ticketId, sender_role: "staff", body: message, is_internal: false });
  if (error) throw new Error(`客服回覆失敗：${error.message}`);
  await supabase.from("support_tickets").update({ status, assigned_to: actor.id, resolved_at: status === "resolved" ? new Date().toISOString() : null, closed_at: status === "closed" ? new Date().toISOString() : null }).eq("id", ticketId);
  await supabase.from("admin_audit_logs").insert({ actor_user_id: actor.id, action: "support.reply", target_type: "support_ticket", target_id: ticketId, after_data: { status } });
  revalidatePath("/admin");
}

export async function updateRiskAction(formData: FormData) {
  const actor = await requireStaff(["admin", "operations", "risk_analyst"]);
  const eventId = String(formData.get("eventId") ?? "");
  const status = String(formData.get("status") ?? "");
  if (!["investigating", "resolved", "false_positive"].includes(status)) throw new Error("風險狀態不正確。");
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("risk_events").update({ status, assigned_to: actor.id, resolved_at: ["resolved", "false_positive"].includes(status) ? new Date().toISOString() : null }).eq("id", eventId);
  if (error) throw new Error(`風險事件更新失敗：${error.message}`);
  await supabase.from("admin_audit_logs").insert({ actor_user_id: actor.id, action: "risk.update", target_type: "risk_event", target_id: eventId, after_data: { status } });
  revalidatePath("/admin");
}
