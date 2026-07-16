import "server-only";

import { getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET } from "./supabase";

const PERSON_RETENTION_DAYS = 30;
const RESULT_RETENTION_DAYS = 90;
const ACCOUNT_DELETION_GRACE_DAYS = 7;

interface JobPathRow { id: string; person_image_url?: string | null; result_image_url?: string | null }

export async function runRetentionBatch(): Promise<{
  personPhotos: number;
  resultPhotos: number;
  notificationLogs: number;
  supportRecords: number;
  authAttempts: number;
  accountsCompleted: number;
  accountsBlocked: number;
}> {
  const personPhotos = await purgeJobImages("person_image_url", PERSON_BUCKET, PERSON_RETENTION_DAYS);
  const resultPhotos = await purgeJobImages("result_image_url", RESULT_BUCKET, RESULT_RETENTION_DAYS);
  const notificationLogs = await purgeNotificationLogs();
  const supportRecords = await anonymizeSupportRecords();
  const authAttempts = await purgeAuthAttempts();
  const accounts = await processEligibleAccountDeletions();
  return { personPhotos, resultPhotos, notificationLogs, supportRecords, authAttempts, ...accounts };
}

async function purgeAuthAttempts(): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin().from("auth_attempt_events").delete().lt("created_at", cutoff).select("id").limit(1000);
  if (error) throw new Error(`登入風險紀錄保留政策執行失敗：${error.message}`);
  return data?.length ?? 0;
}

async function purgeNotificationLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - 180 * 86_400_000).toISOString();
  const { data, error } = await getSupabaseAdmin().from("notification_outbox").delete().in("status", ["sent", "skipped"]).lt("updated_at", cutoff).select("id").limit(500);
  if (error) throw new Error(`通知保留政策執行失敗：${error.message}`);
  return data?.length ?? 0;
}

async function anonymizeSupportRecords(): Promise<number> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - 1095 * 86_400_000).toISOString();
  const { data, error } = await supabase.from("support_tickets").select("id").in("status", ["resolved", "closed"]).lt("last_activity_at", cutoff).neq("subject", "[已依保留政策去識別化]").limit(100).returns<{ id: string }[]>();
  if (error) throw new Error(`客服保留政策查詢失敗：${error.message}`);
  let count = 0;
  for (const ticket of data ?? []) {
    const { error: messageError } = await supabase.from("support_messages").update({ body: "[已依保留政策移除內容]", sender_user_id: null }).eq("ticket_id", ticket.id).eq("sender_role", "customer");
    const { error: ticketError } = await supabase.from("support_tickets").update({ subject: "[已依保留政策去識別化]" }).eq("id", ticket.id);
    if (!messageError && !ticketError) count += 1;
  }
  return count;
}

async function purgeJobImages(column: "person_image_url" | "result_image_url", bucket: string, retentionDays: number): Promise<number> {
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const { data, error } = await supabase.from("try_on_jobs").select(`id, ${column}`).lt("created_at", cutoff).not(column, "is", null).limit(100).returns<JobPathRow[]>();
  if (error) throw new Error(`保留政策查詢失敗：${error.message}`);
  let purged = 0;
  for (const job of data ?? []) {
    const path = job[column];
    if (!path) continue;
    const { count, error: referenceError } = await supabase.from("try_on_jobs").select("id", { head: true, count: "exact" }).eq(column, path).gte("created_at", cutoff);
    if (referenceError) throw new Error(`圖片引用檢查失敗：${referenceError.message}`);
    if ((count ?? 0) > 0) continue;
    // 每次只移除一個明確 Storage path；失敗時不清 DB path，保留下次重試能力。
    const { error: removeError } = await supabase.storage.from(bucket).remove([path]);
    if (removeError && !removeError.message.toLowerCase().includes("not found")) continue;
    const { error: updateError } = await supabase.from("try_on_jobs").update({ [column]: null }).eq("id", job.id).eq(column, path);
    if (!updateError) purged += 1;
  }
  return purged;
}

async function processEligibleAccountDeletions(): Promise<{ accountsCompleted: number; accountsBlocked: number }> {
  if (process.env.ACCOUNT_DELETION_EXECUTION_ENABLED !== "true") return { accountsCompleted: 0, accountsBlocked: 0 };
  const supabase = getSupabaseAdmin();
  const cutoff = new Date(Date.now() - ACCOUNT_DELETION_GRACE_DAYS * 86_400_000).toISOString();
  const { data, error } = await supabase.from("account_deletion_requests").select("id, user_id").eq("status", "pending").lte("requested_at", cutoff).order("requested_at").limit(10).returns<{ id: string; user_id: string }[]>();
  if (error) throw new Error(`帳戶刪除佇列讀取失敗：${error.message}`);
  let accountsCompleted = 0;
  let accountsBlocked = 0;
  for (const request of data ?? []) {
    const [orders, refunds] = await Promise.all([
      supabase.from("orders").select("id", { head: true, count: "exact" }).eq("user_id", request.user_id).not("status", "in", "(cancelled,completed,refunded,expired)"),
      supabase.from("refund_requests").select("id", { head: true, count: "exact" }).eq("user_id", request.user_id).in("status", ["requested", "reviewing", "approved", "processing"]),
    ]);
    if ((orders.count ?? 0) > 0 || (refunds.count ?? 0) > 0 || orders.error || refunds.error) {
      accountsBlocked += 1;
      continue;
    }
    await supabase.from("account_deletion_requests").update({ status: "processing", updated_at: new Date().toISOString() }).eq("id", request.id).eq("status", "pending");
    try {
      await eraseAccount(request.user_id);
      await supabase.from("account_deletion_requests").update({ status: "completed", processed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", request.id);
      accountsCompleted += 1;
    } catch {
      accountsBlocked += 1;
    }
  }
  return { accountsCompleted, accountsBlocked };
}

async function eraseAccount(userId: string): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { data: jobs, error } = await supabase.from("try_on_jobs").select("id, person_image_url, result_image_url").eq("user_id", userId).returns<JobPathRow[]>();
  if (error) throw error;
  for (const job of jobs ?? []) {
    if (job.person_image_url) await supabase.storage.from(PERSON_BUCKET).remove([job.person_image_url]);
    if (job.result_image_url) await supabase.storage.from(RESULT_BUCKET).remove([job.result_image_url]);
    await supabase.from("try_on_jobs").update({ person_image_url: null, result_image_url: null, error_message: null }).eq("id", job.id);
  }
  await supabase.from("addresses").delete().eq("user_id", userId);
  const { data: carts } = await supabase.from("carts").select("id").eq("user_id", userId).returns<{ id: string }[]>();
  for (const cart of carts ?? []) await supabase.from("carts").delete().eq("id", cart.id);
  const { data: tickets } = await supabase.from("support_tickets").select("id").eq("user_id", userId).returns<{ id: string }[]>();
  for (const ticket of tickets ?? []) {
    await supabase.from("support_messages").update({ body: "[已依帳戶刪除政策移除內容]", sender_user_id: null }).eq("ticket_id", ticket.id).eq("sender_role", "customer");
    await supabase.from("support_tickets").update({ subject: "[已去識別化的客服案件]" }).eq("id", ticket.id);
  }
  await supabase.from("users").update({ email: null, closed_at: new Date().toISOString(), anonymized_at: new Date().toISOString() }).eq("id", userId);
  const { error: deleteError } = await supabase.auth.admin.deleteUser(userId);
  if (deleteError) throw deleteError;
}
