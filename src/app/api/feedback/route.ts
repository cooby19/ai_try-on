// POST /api/feedback — 記錄使用者對生成結果的「滿意 / 不滿意」回饋
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/user";
import { getSupabaseAdmin } from "@/lib/supabase";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import type { TryOnJob } from "@/lib/types";

export async function POST(req: Request) {
  try {
    const userId = (await requireUser()).id;

    const body = (await req.json().catch(() => null)) as {
      jobId?: string;
      rating?: string;
      feedbackText?: string;
    } | null;
    if (!body?.jobId || !["satisfied", "unsatisfied"].includes(body.rating ?? "")) {
      return jsonError(400, "回饋資料不完整。");
    }

    const supabase = getSupabaseAdmin();
    const { data: job } = await supabase
      .from("try_on_jobs")
      .select("*")
      .eq("id", body.jobId)
      .eq("user_id", userId) // 只能對自己的任務留回饋
      .single<TryOnJob>();
    if (!job) return jsonError(404, "找不到這筆試穿紀錄。");

    const { error } = await supabase.from("try_on_feedback").insert({
      job_id: job.id,
      user_id: userId,
      product_id: job.product_id,
      rating: body.rating,
      feedback_text: body.feedbackText?.slice(0, 500) ?? null,
    });
    if (error) return jsonError(500, `回饋儲存失敗：${error.message}`);

    return NextResponse.json({ status: "success", message: "已收到你的回饋，謝謝！" });
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
