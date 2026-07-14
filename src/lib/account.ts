import "server-only";

import { createSignedUrl, getSupabaseAdmin, RESULT_BUCKET } from "@/lib/supabase";
import type {
  AccountDeletionRequestStatus,
  AccountDeletionRequestView,
  AccountTryOnItem,
  JobStatus,
} from "@/lib/types";

interface AccountJobRow {
  id: string;
  product_id: string;
  person_image_url: string;
  result_image_url: string | null;
  status: JobStatus;
  created_at: string;
  products: { name: string } | { name: string }[] | null;
}

interface DeletionRequestRow {
  id: string;
  requested_at: string;
  status: AccountDeletionRequestStatus;
  reason: string | null;
}

export async function getAccountOverview(userId: string): Promise<{
  tryOnItems: AccountTryOnItem[];
  pendingDeletionRequest: AccountDeletionRequestView | null;
}> {
  const supabase = getSupabaseAdmin();
  const [jobsResult, deletionResult] = await Promise.all([
    supabase
      .from("try_on_jobs")
      .select(
        "id, product_id, person_image_url, result_image_url, status, created_at, products ( name )"
      )
      .eq("user_id", userId)
      .order("created_at", { ascending: false })
      .returns<AccountJobRow[]>(),
    supabase
      .from("account_deletion_requests")
      .select("id, requested_at, status, reason")
      .eq("user_id", userId)
      .eq("status", "pending")
      .order("requested_at", { ascending: false })
      .limit(1)
      .maybeSingle<DeletionRequestRow>(),
  ]);

  if (jobsResult.error) {
    throw new Error(`讀取試穿紀錄失敗：${jobsResult.error.message}`);
  }
  if (deletionResult.error) {
    throw new Error(`讀取帳戶刪除申請失敗：${deletionResult.error.message}`);
  }

  const tryOnItems = await Promise.all(
    (jobsResult.data ?? []).map(async (job): Promise<AccountTryOnItem> => {
      const photosDeleted = !job.person_image_url && !job.result_image_url;
      const product = Array.isArray(job.products) ? job.products[0] : job.products;
      return {
        jobId: job.id,
        productId: job.product_id,
        productName: product?.name ?? "已下架商品",
        createdAt: job.created_at,
        status: job.status,
        resultImageUrl:
          job.result_image_url && !photosDeleted
            ? await createSignedUrl(RESULT_BUCKET, job.result_image_url)
            : null,
        photosDeleted,
      };
    })
  );

  const pending = deletionResult.data;
  return {
    tryOnItems,
    pendingDeletionRequest: pending
      ? {
          id: pending.id,
          requestedAt: pending.requested_at,
          status: pending.status,
          reason: pending.reason,
        }
      : null,
  };
}
