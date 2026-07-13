// GET    /api/try-on/[jobId] — 輪詢任務狀態；processing 時順便向 provider 查進度
// DELETE /api/try-on/[jobId] — 刪除試穿紀錄與相關照片（隱私需求：使用者可刪除自己的紀錄）
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/user";
import { createSignedUrl, getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET } from "@/lib/supabase";
import { updateJobStatus } from "@/lib/quota";
import { getVTOProvider } from "@/lib/vto";
import { enhanceResultImage } from "@/lib/enhance";
import type { VTOSubmitInput } from "@/lib/vto/provider";
import { loadImageAsPngBuffer } from "@/lib/images";
import { toJpegUploadBlob } from "@/lib/validation";
import { jsonError, errorMessage } from "@/lib/http";
import { rawUploadPathForPersonImage } from "@/lib/upload-intent";
import type { TryOnJob, TryOnJobView } from "@/lib/types";

type RouteParams = { params: Promise<{ jobId: string }> };

async function loadOwnedJob(jobId: string): Promise<TryOnJob | null> {
  const userId = await getUserId();
  if (!userId) return null;
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
    let job = await loadOwnedJob(jobId);
    if (!job) return jsonError(404, "找不到這筆試穿紀錄。");

    // 任務還在進行中 → 向 provider 查一次進度
    if ((job.status === "pending" || job.status === "processing") && job.provider_job_id) {
      const provider = getVTOProvider(job.provider);

      let ctx: VTOSubmitInput | undefined;
      if (provider.requiresImagesOnPoll) {
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
    return jsonError(500, errorMessage(e));
  }
}

export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const { jobId } = await params;
    const job = await loadOwnedJob(jobId);
    if (!job) return jsonError(404, "找不到這筆試穿紀錄。");

    const supabase = getSupabaseAdmin();

    // 刪結果圖
    if (job.result_image_url) {
      await supabase.storage.from(RESULT_BUCKET).remove([job.result_image_url]);
    }
    // 人物照可能被「重新生成」的其他任務共用，確認沒有其他任務引用才刪檔案
    if (job.person_image_url) {
      const { count } = await supabase
        .from("try_on_jobs")
        .select("id", { count: "exact", head: true })
        .eq("person_image_url", job.person_image_url)
        .neq("id", job.id);
      if (!count) {
        await supabase.storage.from(PERSON_BUCKET).remove([job.person_image_url]);
        const rawLockPath = rawUploadPathForPersonImage(job.person_image_url);
        if (rawLockPath) await supabase.storage.from(PERSON_BUCKET).remove([rawLockPath]);
      }
    }
    // 隱私 vs 成本控管的取捨：照片實體檔案全部刪除、圖片欄位清空（隱私），
    // 但 job 列保留——額度是統計當日筆數，若整列刪除，使用者就能靠
    // 「生成 → 刪除」重複刷額度，成本指標也會失真。
    await supabase
      .from("try_on_jobs")
      .update({
        person_image_url: "",
        result_image_url: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return NextResponse.json({ status: "success", message: "照片已刪除，生成次數紀錄保留。" });
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
