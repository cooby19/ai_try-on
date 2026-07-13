import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireUser } from "@/lib/user";
import { AppError } from "@/lib/http";
import { POST as feedbackPost } from "@/app/api/feedback/route";
import { GET as quotaGet } from "@/app/api/quota/route";
import { POST as tryOnPost } from "@/app/api/try-on/route";
import { GET as uploadGet, POST as uploadPost } from "@/app/api/upload/route";
import { DELETE as jobDelete, GET as jobGet } from "@/app/api/try-on/[jobId]/route";
import { GET as imageGet } from "@/app/api/image/[...slug]/route";

vi.mock("@/lib/user", () => ({ requireUser: vi.fn() }));
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  createSignedUrl: vi.fn(),
  PERSON_BUCKET: "person-uploads",
  RESULT_BUCKET: "try-on-results",
}));

const authMessage = "請先登入後再使用 AI 試穿功能。";
const params = { params: Promise.resolve({ jobId: "job-id" }) };

beforeEach(() => {
  vi.mocked(requireUser).mockRejectedValue(new AppError(401, authMessage));
});

async function expectUnauthorized(response: Response) {
  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toMatchObject({
    status: "failed",
    message: authMessage,
  });
}

describe("AI 試穿相關 API 必須登入", () => {
  it("quota", async () => {
    await expectUnauthorized(await quotaGet(new Request("https://shop.test/api/quota?productId=p1")));
  });

  it("upload prepare/complete 與圖片 URL", async () => {
    await expectUnauthorized(await uploadPost(new Request("https://shop.test/api/upload", { method: "POST" })));
    await expectUnauthorized(await uploadGet(new Request("https://shop.test/api/upload?path=x")));
  });

  it("建立與取得試穿結果", async () => {
    await expectUnauthorized(await tryOnPost(new Request("https://shop.test/api/try-on", { method: "POST" })));
    await expectUnauthorized(await jobGet(new Request("https://shop.test/api/try-on/job-id"), params));
  });

  it("回饋與刪除試穿紀錄", async () => {
    await expectUnauthorized(await feedbackPost(new Request("https://shop.test/api/feedback", { method: "POST" })));
    await expectUnauthorized(await jobDelete(new Request("https://shop.test/api/try-on/job-id", { method: "DELETE" }), params));
  });

  it("舊圖片 fallback 也不接受簽章取代登入身分", async () => {
    await expectUnauthorized(
      await imageGet(new Request("https://shop.test/api/image/person-uploads/user/photo.jpg"), {
        params: Promise.resolve({ slug: ["person-uploads", "user", "photo.jpg"] }),
      })
    );
  });
});
