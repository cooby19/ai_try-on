// POST /api/try-on — 建立 AI 試穿任務（規格書第九節）
// 流程：驗證輸入 → 檢查額度 → 建 try_on_jobs(pending) → 呼叫 provider 送出任務
//       → status = processing → 回傳 jobId，讓前端輪詢 GET /api/try-on/[jobId]。
// 失敗時：status = failed + error_message，回傳「可操作」的錯誤訊息。
import { NextResponse } from "next/server";
import { getOrCreateUserId } from "@/lib/user";
import { getSupabaseAdmin, PERSON_BUCKET } from "@/lib/supabase";
import {
  checkGenerationQuota,
  recordTryOnJob,
  updateJobStatus,
  verifyJobWithinQuota,
} from "@/lib/quota";
import { getVTOProvider, resolveVTOProviderName } from "@/lib/vto";
import { loadImageAsPngBuffer } from "@/lib/images";
import { jsonError, errorMessage } from "@/lib/http";
import type { Product } from "@/lib/types";

export async function POST(req: Request) {
  try {
    const userId = await getOrCreateUserId();
    const body = (await req.json().catch(() => null)) as {
      productId?: string;
      personImagePath?: string;
      model?: unknown; // 使用者選的生成模型（選填）；型別與白名單驗證交給 resolveVTOProviderName
    } | null;

    // 1. 驗證輸入
    if (!body?.productId || !body?.personImagePath) {
      return jsonError(400, "缺少商品或人物照片資訊，請重新操作一次。");
    }
    // 使用者選的模型走白名單映射成 provider 名稱（防止直接注入任意 provider）；
    // 不合法值直接擋下，不建 job——此時尚未占用額度。
    const providerName = resolveVTOProviderName(body.model);
    if (!providerName) {
      return jsonError(400, "不支援的生成模型，請重新整理頁面後再選擇一次。");
    }
    // 人物照路徑必須屬於目前使用者，防止拿別人的照片生成
    if (!body.personImagePath.startsWith(`${userId}/`)) {
      return jsonError(403, "照片來源驗證失敗，請重新上傳照片。");
    }

    const supabase = getSupabaseAdmin();
    const { data: product } = await supabase
      .from("products")
      .select("*")
      .eq("id", body.productId)
      .single<Product>();
    if (!product) return jsonError(404, "找不到這個商品，請重新整理頁面。");

    // 2. 檢查生成額度（每日 3 次、每商品重試 2 次）
    const quota = await checkGenerationQuota(userId, body.productId);
    if (!quota.allowed) {
      return jsonError(429, quota.reason ?? "已達生成上限。", {
        remainingToday: quota.remainingToday,
      });
    }

    // 3. 建立任務紀錄（status = pending；建立紀錄本身就是額度 +1）
    // provider 由上面白名單解析的名稱決定；providerName / costEstimate 會寫進 job，
    // 之後輪詢用 job.provider 還原，所以選 Max 的任務全程都走 Max。
    const provider = getVTOProvider(providerName);
    const job = await recordTryOnJob({
      userId,
      productId: body.productId,
      personImagePath: body.personImagePath,
      garmentImageUrl: product.garment_image_url,
      provider: provider.providerName,
      costEstimate: provider.costEstimate,
      retryCount: quota.productAttemptsToday,
    });

    try {
      // 3.5 插入後複驗名次：步驟 2 的檢查與步驟 3 的插入非原子，並發請求可能
      // 同時通過檢查而超額；在真正花錢（provider.submit）之前用確定性名次做
      // 最終判定，競態落敗列會被刪除（為什麼可以刪，見 quota.ts 的註解）。
      // 若複驗查詢本身失敗會 throw，由下方 catch 標記 failed——列保留、不花錢。
      const verification = await verifyJobWithinQuota({
        jobId: job.id,
        userId,
        productId: body.productId,
        retryCount: quota.productAttemptsToday,
      });
      if (!verification.allowed) {
        return jsonError(429, verification.reason ?? "已達生成上限。", {
          remainingToday: verification.remainingToday,
        });
      }

      // 4. 載入圖片並送出到 VTO provider
      const { data: personFile, error: downloadError } = await supabase.storage
        .from(PERSON_BUCKET)
        .download(body.personImagePath);
      if (downloadError || !personFile) {
        throw new Error("讀取不到剛上傳的照片，請重新上傳一次。");
      }
      const personImage = Buffer.from(await personFile.arrayBuffer());
      const garmentImage = await loadImageAsPngBuffer(product.garment_image_url);

      const { providerJobId } = await provider.submit({
        personImage,
        garmentImage,
        garmentType: "tops",
      });

      // 5. 送出成功 → processing，等前端輪詢
      await updateJobStatus(job.id, { status: "processing", provider_job_id: providerJobId });
      return NextResponse.json({
        jobId: job.id,
        status: "processing",
        costEstimate: provider.costEstimate,
        // 用複驗後的剩餘次數（已含並發請求），比「前置檢查 - 1」在競態下更準
        remainingToday: verification.remainingToday,
      });
    } catch (e) {
      // 失敗也要留下紀錄（status / error_message / 成本都已寫入）
      const message = errorMessage(e);
      await updateJobStatus(job.id, { status: "failed", error_message: message });
      return jsonError(502, message, { jobId: job.id });
    }
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
