// GET /api/image/{bucket}/{path...} — 舊版短期相容 fallback。
// 新版 API 已改回傳 Supabase Storage signed URL；新頁面不會再產生此 route 的網址。
// V0.2 起即使持有舊簽章，也必須登入且只能讀取目前 Auth 使用者資料夾。
//
// 為什麼存在：人物照與結果圖存在私有 bucket，前端原本拿的是 supabase.co 的短期 signed URL。
// 但有些網路（飯店 / 公司 / 部分地區）會封鎖 supabase.co，瀏覽器直連就拿不到圖（顯示破圖）。
// 改由後端在伺服器端向 Supabase 取圖、再從「本站網域」吐回給瀏覽器，即可繞過這類封鎖
// （瀏覽器只跟本站溝通，就像站內靜態圖一樣）。
//
// 隱私維持：舊網址帶「簽章 + 效期」(?exp&sig)，本身即為限時存取憑證（見 src/lib/supabase.ts
// 的 verifyImageSignature）——與登入 session 雙重驗證，簽章本身不再是授權身分。
import { getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET, verifyImageSignature } from "@/lib/supabase";
import { jsonError, errorMessage, errorStatus } from "@/lib/http";
import { fitImageToResponseLimit, MAX_IMAGE_RESPONSE_BYTES } from "@/lib/image-payload";
import { requireUser } from "@/lib/user";

type RouteParams = { params: Promise<{ slug: string[] }> };

// 只開放這兩個私有 bucket，避免這個端點被拿去讀 storage 內其他內容
const ALLOWED_BUCKETS = new Set<string>([PERSON_BUCKET, RESULT_BUCKET]);

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const userId = (await requireUser()).id;
    const { slug } = await params;
    // slug = [bucket, ...pathParts]；至少要有 bucket + 一段路徑
    if (!slug || slug.length < 2) return jsonError(404, "找不到圖片。");

    const [bucket, ...rest] = slug;
    if (!ALLOWED_BUCKETS.has(bucket)) return jsonError(404, "找不到圖片。");

    const storagePath = rest.join("/");
    // 路徑跳脫防護：拒絕 .. 之類試圖跳出使用者資料夾的路徑
    if (
      !storagePath ||
      storagePath.includes("..") ||
      !storagePath.startsWith(`${userId}/`)
    ) {
      return jsonError(404, "找不到圖片。");
    }

    // 授權：驗證網址上的簽章與效期（憑證即網址），不依賴 cookie。
    // 一律回 404（而非 403），不洩漏「這張圖是否存在」。
    const url = new URL(req.url);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig") ?? "";
    if (!verifyImageSignature(bucket, storagePath, exp, sig)) {
      return jsonError(404, "找不到圖片。");
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(bucket).download(storagePath);
    if (error || !data) return jsonError(404, "找不到圖片。");

    // 安全大小內維持原本串流路徑，避免二進位被文字轉碼，也不增加正常圖片的 sharp 成本。
    // 串流不會繞過 Vercel 的 4.5 MB response 上限，因此超過 4 MiB 時必須先壓縮／縮圖。
    if (data.size > MAX_IMAGE_RESPONSE_BYTES) {
      const safe = await fitImageToResponseLimit(Buffer.from(await data.arrayBuffer()));
      return new Response(Uint8Array.from(safe.buffer), {
        status: 200,
        headers: {
          "Content-Type": safe.contentType,
          "Content-Length": String(safe.buffer.length),
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    return new Response(data.stream(), {
      status: 200,
      headers: {
        "Content-Type": data.type || "image/jpeg",
        // 圖檔以 uuid 命名、內容不變，可讓瀏覽器私有快取；private 確保不落入共用快取
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return jsonError(errorStatus(e), errorMessage(e));
  }
}
