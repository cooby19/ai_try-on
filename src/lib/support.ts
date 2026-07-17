import "server-only";

import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import type { SupportCategory, SupportTicketStatus, SupportTicketView } from "./types";

const CATEGORIES = new Set<SupportCategory>(["order", "payment", "refund", "try_on", "privacy", "account", "other"]);

interface TicketRow {
  id: string;
  ticket_number: string;
  order_id: string | null;
  category: SupportCategory;
  subject: string;
  status: SupportTicketStatus;
  priority: SupportTicketView["priority"];
  last_activity_at: string;
  created_at: string;
  support_messages?: MessageRow[];
}

interface MessageRow {
  id: string;
  sender_role: "customer" | "staff" | "system";
  body: string;
  created_at: string;
  is_internal?: boolean;
}

export async function listSupportTicketsForUser(userId: string): Promise<SupportTicketView[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("support_tickets")
    .select("id, ticket_number, order_id, category, subject, status, priority, last_activity_at, created_at, support_messages(id, sender_role, body, created_at, is_internal)")
    .eq("user_id", userId)
    .order("last_activity_at", { ascending: false })
    .returns<TicketRow[]>();
  if (error) throw new AppError(500, `客服案件讀取失敗：${error.message}`);
  return (data ?? []).map(toTicketView);
}

export async function createSupportTicket(userId: string, email: string, input: unknown): Promise<SupportTicketView> {
  const body = parseTicketInput(input);
  const supabase = getSupabaseAdmin();
  if (body.orderId) {
    const { data: order, error } = await supabase.from("orders").select("id").eq("id", body.orderId).eq("user_id", userId).maybeSingle();
    if (error) throw new AppError(500, `訂單驗證失敗：${error.message}`);
    if (!order) throw new AppError(404, "找不到要關聯的訂單。");
  }

  const { data: ticket, error: ticketError } = await supabase
    .from("support_tickets")
    .insert({ user_id: userId, order_id: body.orderId, category: body.category, subject: body.subject })
    .select("id, ticket_number, order_id, category, subject, status, priority, last_activity_at, created_at")
    .single<TicketRow>();
  if (ticketError || !ticket) throw new AppError(500, `客服案件建立失敗：${ticketError?.message ?? "回應不完整"}`);

  const { data: message, error: messageError } = await supabase
    .from("support_messages")
    .insert({ ticket_id: ticket.id, sender_user_id: userId, sender_role: "customer", body: body.message })
    .select("id, sender_role, body, created_at")
    .single<MessageRow>();
  if (messageError || !message) {
    await supabase.from("support_tickets").delete().eq("id", ticket.id);
    throw new AppError(500, `客服訊息建立失敗：${messageError?.message ?? "回應不完整"}`);
  }

  await supabase.from("notification_outbox").insert({
    user_id: userId,
    recipient_email: email,
    template: "support_ticket_created",
    payload: { ticketId: ticket.id, ticketNumber: ticket.ticket_number, subject: ticket.subject },
    dedupe_key: `support-ticket:${ticket.id}`,
  });
  return toTicketView({ ...ticket, support_messages: [message] });
}

export async function addCustomerSupportMessage(userId: string, ticketId: string, rawBody: unknown): Promise<void> {
  if (!isUuid(ticketId) || typeof rawBody !== "string" || !rawBody.trim() || rawBody.trim().length > 5000) {
    throw new AppError(400, "客服訊息須為 1–5000 字。");
  }
  const supabase = getSupabaseAdmin();
  const { data: ticket, error } = await supabase
    .from("support_tickets")
    .select("id, status")
    .eq("id", ticketId)
    .eq("user_id", userId)
    .maybeSingle<{ id: string; status: SupportTicketStatus }>();
  if (error) throw new AppError(500, `客服案件驗證失敗：${error.message}`);
  if (!ticket) throw new AppError(404, "找不到客服案件。");
  if (ticket.status === "closed") throw new AppError(409, "此客服案件已關閉，請建立新案件。");
  const { error: insertError } = await supabase.from("support_messages").insert({
    ticket_id: ticketId,
    sender_user_id: userId,
    sender_role: "customer",
    body: rawBody.trim(),
  });
  if (insertError) throw new AppError(500, `客服訊息送出失敗：${insertError.message}`);
  await supabase.from("support_tickets").update({ status: "open" }).eq("id", ticketId);
}

function parseTicketInput(input: unknown): { category: SupportCategory; subject: string; message: string; orderId: string | null } {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new AppError(400, "客服案件格式不正確。");
  const body = input as Record<string, unknown>;
  const category = body.category;
  const subject = typeof body.subject === "string" ? body.subject.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const orderId = typeof body.orderId === "string" && body.orderId.trim() ? body.orderId.trim() : null;
  if (typeof category !== "string" || !CATEGORIES.has(category as SupportCategory)) throw new AppError(400, "客服類別不正確。");
  if (subject.length < 3 || subject.length > 120) throw new AppError(400, "主旨須為 3–120 字。");
  if (!message || message.length > 5000) throw new AppError(400, "訊息須為 1–5000 字。");
  if (orderId && !isUuid(orderId)) throw new AppError(400, "訂單識別碼不正確。");
  return { category: category as SupportCategory, subject, message, orderId };
}

function toTicketView(row: TicketRow): SupportTicketView {
  return {
    id: row.id,
    ticketNumber: row.ticket_number,
    orderId: row.order_id,
    category: row.category,
    subject: row.subject,
    status: row.status,
    priority: row.priority,
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    messages: (row.support_messages ?? [])
      .filter((message) => !message.is_internal)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map((message) => ({ id: message.id, senderRole: message.sender_role, body: message.body, createdAt: message.created_at })),
  };
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
