// POST /api/try-on — HTTP/Auth 邊界；生成編排由 server-only Workflow 負責。
import { NextResponse } from "next/server";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import { startTryOnWorkflow } from "@/lib/try-on/workflow";
import { requireUser } from "@/lib/user";

export async function POST(req: Request) {
  try {
    const userId = (await requireUser()).id;
    const body = (await req.json().catch(() => null)) as {
      productId?: string;
      personImagePath?: string;
      model?: unknown; // 使用者選的生成模型（選填）；型別與白名單驗證交給 resolveVTOProviderName
    } | null;

    const result = await startTryOnWorkflow({
      userId,
      productId: body?.productId,
      personImagePath: body?.personImagePath,
      requestedModel: body?.model,
      idempotencyKey: req.headers.get("Idempotency-Key") ?? undefined,
    });
    if (result.ok) {
      return NextResponse.json({
        jobId: result.jobId,
        status: result.status,
        costEstimate: result.costEstimate,
        remainingToday: result.remainingToday,
      });
    }

    if (result.code === "quota_rejected") {
      return jsonError(429, result.message, { remainingToday: result.remainingToday });
    }
    if (result.code === "submission_failed") {
      return jsonError(502, result.message, { jobId: result.jobId });
    }
    if (result.code === "idempotency_conflict") {
      return jsonError(409, result.message);
    }
    const status =
      result.code === "invalid_person_image"
        ? 403
        : result.code === "product_not_found"
          ? 404
          : 400;
    return jsonError(status, result.message);
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
