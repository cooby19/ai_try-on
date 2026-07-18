// GET /api/quota?productId=xxx — 查詢目前剩餘生成額度（給前端顯示用）
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/user";
import {
  checkGenerationQuota,
  DAILY_GENERATION_LIMIT,
  GENERATION_LIMITS_ENABLED,
} from "@/lib/quota";
import { getDefaultUserModel } from "@/lib/vto";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";

export async function GET(req: Request) {
  try {
    const productId = new URL(req.url).searchParams.get("productId");
    if (!productId) return jsonError(400, "缺少 productId。");

    // 目前環境的預設生成模型；null 代表不開放選模型（如 mock 模式），
    // 前端據此隱藏模型選擇器，避免在沒有真實 API 的環境誤導使用者。
    const defaultModel = getDefaultUserModel();

    const userId = (await requireUser()).id;
    const quota = await checkGenerationQuota(userId, productId);
    return NextResponse.json(
      GENERATION_LIMITS_ENABLED
        ? {
            generationLimitsEnabled: true,
            remainingToday: quota.remainingToday,
            remainingRetriesForProduct: quota.remainingRetriesForProduct,
            dailyLimit: DAILY_GENERATION_LIMIT,
            defaultModel,
          }
        : {
            generationLimitsEnabled: false,
            defaultModel,
          },
    );
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
