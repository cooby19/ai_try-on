// GET    /api/try-on/[jobId] — 輪詢任務狀態；processing 時順便向 provider 查進度
// DELETE /api/try-on/[jobId] — 刪除相關照片但保留試穿／額度紀錄
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/user";
import { getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET } from "@/lib/supabase";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import { rawUploadPathForPersonImage } from "@/lib/upload-intent";
import { getAndAdvanceTryOnWorkflow } from "@/lib/try-on/workflow";
import type { TryOnJob } from "@/lib/types";

type RouteParams = { params: Promise<{ jobId: string }> };

async function loadOwnedJob(jobId: string, userId: string): Promise<TryOnJob | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from("try_on_jobs")
    .select("*")
    .eq("id", jobId)
    .eq("user_id", userId) // 只能查 / 刪自己的任務
    .single<TryOnJob>();
  return data ?? null;
}

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const userId = (await requireUser()).id;
    const result = await getAndAdvanceTryOnWorkflow({ jobId, userId });
    if (!result.ok) {
      return jsonError(result.code === "job_not_found" ? 404 : 409, result.message);
    }
    return NextResponse.json(result.view);
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const userId = (await requireUser()).id;
    const job = await loadOwnedJob(jobId, userId);
    if (!job) return jsonError(404, "找不到這筆試穿紀錄。");

    const supabase = getSupabaseAdmin();

    // Storage 每次只刪一個明確 path；任一步驟失敗就不清 DB 欄位，讓使用者可重試。
    if (job.result_image_url) {
      const { error } = await supabase.storage.from(RESULT_BUCKET).remove([job.result_image_url]);
      if (error) return jsonError(500, `結果照刪除失敗：${error.message}`);
    }
    // 人物照可能被「重新生成」的其他任務共用，確認沒有其他任務引用才刪檔案
    if (job.person_image_url) {
      const { count, error: referenceError } = await supabase
        .from("try_on_jobs")
        .select("id", { count: "exact", head: true })
        .eq("person_image_url", job.person_image_url)
        .neq("id", job.id);
      if (referenceError) {
        return jsonError(500, `人物照引用檢查失敗：${referenceError.message}`);
      }
      if (!count) {
        const { error } = await supabase.storage.from(PERSON_BUCKET).remove([job.person_image_url]);
        if (error) return jsonError(500, `人物照刪除失敗：${error.message}`);
        const rawLockPath = rawUploadPathForPersonImage(job.person_image_url);
        if (rawLockPath) {
          const { error: rawLockError } = await supabase.storage
            .from(PERSON_BUCKET)
            .remove([rawLockPath]);
          if (rawLockError) return jsonError(500, `上傳鎖刪除失敗：${rawLockError.message}`);
        }
      }
    }
    // 隱私 vs 成本控管的取捨：不再被其他 job 引用的照片檔案刪除、
    // 此 job 的圖片欄位清空，但 job 列保留——額度是統計當日筆數，若整列刪除，使用者就能靠
    // 「生成 → 刪除」重複刷額度，成本指標也會失真。
    // 尚在 provider 處理中的工作若只清圖片 path，之後 GET 輪詢可能重新存回結果圖。
    // 將它收斂成 failed 並清 provider_job_id，避免使用者刪除後又產生新檔案。
    const jobStatus = job.status === "pending" || job.status === "processing" ? "failed" : job.status;
    const updatedAt = new Date().toISOString();
    const { error: updateError } = await supabase
      .from("try_on_jobs")
      .update({
        person_image_url: "",
        result_image_url: null,
        ...(jobStatus === "failed" && job.status !== "failed"
          ? {
              status: "failed",
              provider_job_id: null,
              error_message: "使用者已刪除照片，未保留處理結果。",
              error_type: "input_validation",
              error_code: "SOURCE_IMAGE_DELETED",
              completed_at: updatedAt,
            }
          : {}),
        updated_at: updatedAt,
      })
      .eq("id", job.id)
      .eq("user_id", userId);
    if (updateError) return jsonError(500, `試穿紀錄更新失敗：${updateError.message}`);

    return NextResponse.json({
      status: "success",
      message: "照片已刪除，試穿與生成次數紀錄保留。",
      jobStatus,
    });
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
