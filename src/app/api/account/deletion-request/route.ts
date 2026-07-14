import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import { getSupabaseAdmin } from "@/lib/supabase";
import type { AccountDeletionRequestStatus, AccountDeletionRequestView } from "@/lib/types";
import { requireUser } from "@/lib/user";

interface DeletionRequestRow {
  id: string;
  requested_at: string;
  status: AccountDeletionRequestStatus;
  reason: string | null;
}

async function findPendingRequest(supabase: SupabaseClient, userId: string) {
  return supabase
    .from("account_deletion_requests")
    .select("id, requested_at, status, reason")
    .eq("user_id", userId)
    .eq("status", "pending")
    .order("requested_at", { ascending: false })
    .limit(1)
    .maybeSingle<DeletionRequestRow>();
}

function toView(row: DeletionRequestRow): AccountDeletionRequestView {
  return {
    id: row.id,
    requestedAt: row.requested_at,
    status: row.status,
    reason: row.reason,
  };
}

export async function POST(req: Request) {
  try {
    const userId = (await requireUser()).id;
    if (!req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      return jsonError(415, "請使用 JSON 格式送出申請。");
    }

    const body = (await req.json().catch(() => null)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return jsonError(400, "申請資料格式不正確。");
    }
    const rawReason = (body as Record<string, unknown>).reason;
    if (rawReason !== undefined && rawReason !== null && typeof rawReason !== "string") {
      return jsonError(400, "申請原因格式不正確。");
    }
    const reason = typeof rawReason === "string" ? rawReason.trim() || null : null;
    if (reason && reason.length > 1000) {
      return jsonError(422, "申請原因不可超過 1000 字。");
    }

    const supabase = getSupabaseAdmin();
    const existing = await findPendingRequest(supabase, userId);
    if (existing.error) {
      return jsonError(500, `讀取既有申請失敗：${existing.error.message}`);
    }
    if (existing.data) {
      return NextResponse.json({
        status: "success",
        message: "已收到你的帳戶刪除申請。",
        alreadyPending: true,
        request: toView(existing.data),
      });
    }

    const { data, error } = await supabase
      .from("account_deletion_requests")
      .insert({ user_id: userId, reason, status: "pending" })
      .select("id, requested_at, status, reason")
      .single<DeletionRequestRow>();

    // 部分唯一索引處理同一使用者的並發送出；競態輸家回既有 pending，而非 500。
    if (error?.code === "23505") {
      const concurrent = await findPendingRequest(supabase, userId);
      if (concurrent.data) {
        return NextResponse.json({
          status: "success",
          message: "已收到你的帳戶刪除申請。",
          alreadyPending: true,
          request: toView(concurrent.data),
        });
      }
    }
    if (error || !data) {
      return jsonError(500, `帳戶刪除申請儲存失敗：${error?.message ?? "找不到新增資料"}`);
    }

    return NextResponse.json(
      {
        status: "success",
        message: "已收到你的帳戶刪除申請。",
        alreadyPending: false,
        request: toView(data),
      },
      { status: 201 }
    );
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
