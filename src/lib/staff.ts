import "server-only";

import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import { requireUser } from "./user";

export type StaffRole = "admin" | "operations" | "support" | "risk_analyst";

export async function getStaffRoles(userId: string): Promise<StaffRole[]> {
  const { data, error } = await getSupabaseAdmin().from("user_roles").select("role").eq("user_id", userId).returns<{ role: StaffRole }[]>();
  if (error) return [];
  return (data ?? []).map((item) => item.role);
}

export async function requireStaff(allowed: StaffRole[]): Promise<{ id: string; roles: StaffRole[] }> {
  const user = await requireUser();
  const roles = await getStaffRoles(user.id);
  if (!roles.some((role) => allowed.includes(role))) throw new AppError(403, "你沒有執行此營運操作的權限。");
  return { id: user.id, roles };
}

export async function getOperationsDashboard() {
  const supabase = getSupabaseAdmin();
  const [refunds, tickets, risks, deletions] = await Promise.all([
    supabase.from("refund_requests").select("id, order_id, request_type, reason, requested_amount, approved_amount, status, created_at, orders(order_number)").in("status", ["requested", "reviewing", "approved", "processing"]).order("created_at").limit(50),
    supabase.from("support_tickets").select("id, ticket_number, subject, status, priority, last_activity_at").in("status", ["open", "waiting_customer", "in_progress"]).order("last_activity_at", { ascending: false }).limit(50),
    supabase.from("risk_events").select("id, event_type, severity, status, order_id, details, created_at").in("status", ["open", "investigating"]).order("created_at", { ascending: false }).limit(50),
    supabase.from("account_deletion_requests").select("id, user_id, reason, status, requested_at").in("status", ["pending", "processing"]).order("requested_at").limit(50),
  ]);
  const error = refunds.error ?? tickets.error ?? risks.error ?? deletions.error;
  if (error) throw new AppError(500, `營運資料讀取失敗：${error.message}`);
  return { refunds: refunds.data ?? [], tickets: tickets.data ?? [], risks: risks.data ?? [], deletions: deletions.data ?? [] };
}
