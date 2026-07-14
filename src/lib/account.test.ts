import { afterEach, describe, expect, it, vi } from "vitest";
import { createSignedUrl, getSupabaseAdmin } from "@/lib/supabase";
import { getAccountOverview } from "@/lib/account";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase", () => ({
  getSupabaseAdmin: vi.fn(),
  createSignedUrl: vi.fn(),
  RESULT_BUCKET: "try-on-results",
}));

afterEach(() => vi.clearAllMocks());

describe("帳戶中心資料邊界", () => {
  it("試穿與刪除申請都只查目前 Auth user，並只把短效結果 URL 放進 DTO", async () => {
    const jobs = [
      {
        id: "job-newest",
        product_id: "product-1",
        person_image_url: "current-user/person.jpg",
        result_image_url: "current-user/result.jpg",
        status: "success",
        created_at: "2026-07-13T03:00:00.000Z",
        products: { name: "經典白色圓領 T 恤" },
      },
      {
        id: "job-deleted",
        product_id: "product-2",
        person_image_url: "",
        result_image_url: null,
        status: "success",
        created_at: "2026-07-12T03:00:00.000Z",
        products: { name: "深藍寬鬆圓領 T 恤" },
      },
    ];

    const returns = vi.fn().mockResolvedValue({ data: jobs, error: null });
    const jobsOrder = vi.fn().mockReturnValue({ returns });
    const jobsEqUser = vi.fn().mockReturnValue({ order: jobsOrder });
    const jobsSelect = vi.fn().mockReturnValue({ eq: jobsEqUser });

    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const deletionLimit = vi.fn().mockReturnValue({ maybeSingle });
    const deletionOrder = vi.fn().mockReturnValue({ limit: deletionLimit });
    const deletionEqStatus = vi.fn().mockReturnValue({ order: deletionOrder });
    const deletionEqUser = vi.fn().mockReturnValue({ eq: deletionEqStatus });
    const deletionSelect = vi.fn().mockReturnValue({ eq: deletionEqUser });

    const from = vi.fn((table: string) =>
      table === "try_on_jobs" ? { select: jobsSelect } : { select: deletionSelect }
    );
    vi.mocked(getSupabaseAdmin).mockReturnValue({ from } as unknown as ReturnType<typeof getSupabaseAdmin>);
    vi.mocked(createSignedUrl).mockResolvedValue("https://storage.test/signed-result");

    const result = await getAccountOverview("current-auth-user");

    expect(jobsEqUser).toHaveBeenCalledWith("user_id", "current-auth-user");
    expect(jobsOrder).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(deletionEqUser).toHaveBeenCalledWith("user_id", "current-auth-user");
    expect(createSignedUrl).toHaveBeenCalledWith("try-on-results", "current-user/result.jpg");
    expect(result.tryOnItems).toEqual([
      expect.objectContaining({
        jobId: "job-newest",
        resultImageUrl: "https://storage.test/signed-result",
        photosDeleted: false,
      }),
      expect.objectContaining({
        jobId: "job-deleted",
        resultImageUrl: null,
        photosDeleted: true,
      }),
    ]);
    expect(result.tryOnItems[0]).not.toHaveProperty("person_image_url");
    expect(result.tryOnItems[0]).not.toHaveProperty("user_id");
  });
});
