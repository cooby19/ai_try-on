// GET    /api/try-on/[jobId] — 輪詢任務狀態；processing 時順便向 provider 查進度
// DELETE /api/try-on/[jobId] — 刪除相關照片但保留試穿／額度紀錄
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/user";
import { createSignedUrl, getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET } from "@/lib/supabase";
import { updateJobStatus } from "@/lib/quota";
import { getVTOProvider } from "@/lib/vto";
import { enhanceResultImage } from "@/lib/enhance";
import type { VTOSubmitInput } from "@/lib/vto/provider";
import { loadImageAsPngBuffer } from "@/lib/images";
import { toJpegUploadBlob } from "@/lib/validation";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import { rawUploadPathForPersonImage } from "@/lib/upload-intent";
import type { TryOnJob, TryOnJobView } from "@/lib/types";

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
    let job = await loadOwnedJob(jobId, userId);
    if (!job) return jsonError(404, "找不到這筆試穿紀錄。");

    // 任務還在進行中 → 向 provider 查一次進度
    if ((job.status === "pending" || job.status === "processing") && job.provider_job_id) {
      const provider = getVTOProvider(job.provider);

      let ctx: VTOSubmitInput | undefined;
      if (provider.requiresImagesOnPoll) {
        if (!job.person_image_url) {
          await updateJobStatus(job.id, { status: "failed", error_message: "人物照已依資料保留政策清除。" });
          return jsonError(409, "此試穿任務的原始照片已清除，無法繼續處理。");
        }
        const supabase = getSupabaseAdmin();
        const { data: personFile } = await supabase.storage
          .from(PERSON_BUCKET)
          .download(job.person_image_url);
        if (personFile) {
          ctx = {
            personImage: Buffer.from(await personFile.arrayBuffer()),
            garmentImage: await loadImageAsPngBuffer(job.garment_image_url),
            garmentType: "tops",
          };
        }
      }

      const result = await provider.checkStatus(job.provider_job_id, ctx);
      if (result.status === "success") {
        // 存檔前先做放大後處理（目前只針對 v1.6，補其 864×1296 的解析度缺口；
        // mock / fashn-max 直接跳過）。放大失敗會在 enhance 層降級回原圖，
        // 這裡拿到的 image 永遠可用，job 照常標 success。
        const enhanceOutcome = await enhanceResultImage(result.resultImage, job.provider);
        // 結果圖存進私有 bucket，前端之後只拿 Supabase 的短效 signed URL。
        const resultPath = `${job.user_id}/${job.id}.jpg`;
        const supabase = getSupabaseAdmin();
        // 與人物照上傳相同：Vercel 上不能直接把 Node Buffer 交給 storage-js，
        // 否則 JPEG 的非 UTF-8 位元可能在 server fetch 路徑被改寫，造成檔案存在但瀏覽器無法解碼。
        const uploadBody = toJpegUploadBlob(enhanceOutcome.image);
        const { error: uploadError } = await supabase.storage
          .from(RESULT_BUCKET)
          .upload(resultPath, uploadBody, { contentType: "image/jpeg", upsert: true });
        if (uploadError) {
          await updateJobStatus(job.id, {
            status: "failed",
            error_message: `結果圖儲存失敗：${uploadError.message}`,
          });
          job = { ...job, status: "failed", error_message: "結果圖儲存失敗，請重新生成一次。" };
        } else {
          await updateJobStatus(job.id, { status: "success", result_image_url: resultPath });
          job = { ...job, status: "success", result_image_url: resultPath };
          if (enhanceOutcome.enhanced) {
            // 只有真的執行了放大才把放大成本加進 cost_estimate（降級時不加）。
            // 刻意不擴充 quota.ts 的 updateJobStatus 欄位——那是額度模組，本功能不動它；
            // cost_estimate 純供成本統計，更新失敗只記 log、不影響回給使用者的結果。
            const newCost = Number(job.cost_estimate) + enhanceOutcome.extraCost;
            const { error: costError } = await supabase
              .from("try_on_jobs")
              .update({ cost_estimate: newCost, updated_at: new Date().toISOString() })
              .eq("id", job.id);
            if (costError) {
              console.error(`更新放大成本失敗（job ${job.id}）：`, costError.message);
            } else {
              job = { ...job, cost_estimate: newCost };
            }
          }
        }
      } else if (result.status === "failed") {
        await updateJobStatus(job.id, { status: "failed", error_message: result.errorMessage });
        job = { ...job, status: "failed", error_message: result.errorMessage };
      }
      // processing → 維持原狀，前端稍後再輪詢
    }

    // 私有圖片由 Supabase Storage/CDN 直接傳給瀏覽器，不再經過 Vercel response payload。
    // 每次輪詢都重新簽 1 小時 URL；前端圖片 onError 也會重查本端點取得新 URL。
    const [personImageUrl, resultImageUrl] = await Promise.all([
      job.person_image_url ? createSignedUrl(PERSON_BUCKET, job.person_image_url) : null,
      job.result_image_url ? createSignedUrl(RESULT_BUCKET, job.result_image_url) : null,
    ]);
    const view: TryOnJobView = {
      jobId: job.id,
      status: job.status,
      personImageUrl,
      resultImageUrl,
      costEstimate: Number(job.cost_estimate),
      retryCount: job.retry_count,
      ...(job.error_message ? { message: job.error_message } : {}),
    };
    return NextResponse.json(view);
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
            }
          : {}),
        updated_at: new Date().toISOString(),
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
