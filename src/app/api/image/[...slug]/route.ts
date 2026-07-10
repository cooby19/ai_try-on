// GET /api/image/{bucket}/{path...} — 私有圖片轉發（人物照 / 試穿結果圖）
//
// 為什麼存在：人物照與結果圖存在私有 bucket，前端原本拿的是 supabase.co 的短期 signed URL。
// 但有些網路（飯店 / 公司 / 部分地區）會封鎖 supabase.co，瀏覽器直連就拿不到圖（顯示破圖）。
// 改由後端在伺服器端向 Supabase 取圖、再從「本站網域」吐回給瀏覽器，即可繞過這類封鎖
// （瀏覽器只跟本站溝通，就像站內靜態圖一樣）。
//
// 隱私維持：網址帶「簽章 + 效期」(?exp&sig)，本身即為限時存取憑證（見 src/lib/supabase.ts
// 的 imageProxyUrl / verifyImageSignature）——與原本 Supabase signed URL 同樣的限時能力模型，
// 只是改在自家網域。刻意不用 cookie 驗證：部分瀏覽器不會把 cookie 帶進 <img> 請求，會誤判成
// 無權限而破圖；憑證放在網址上就沒有這個問題。
import { getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET, verifyImageSignature } from "@/lib/supabase";
import { jsonError, errorMessage } from "@/lib/http";

type RouteParams = { params: Promise<{ slug: string[] }> };

// 只開放這兩個私有 bucket，避免這個端點被拿去讀 storage 內其他內容
const ALLOWED_BUCKETS = new Set<string>([PERSON_BUCKET, RESULT_BUCKET]);

export async function GET(req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    // slug = [bucket, ...pathParts]；至少要有 bucket + 一段路徑
    if (!slug || slug.length < 2) return jsonError(404, "找不到圖片。");

    const [bucket, ...rest] = slug;
    if (!ALLOWED_BUCKETS.has(bucket)) return jsonError(404, "找不到圖片。");

    const storagePath = rest.join("/");
    // 路徑跳脫防護：拒絕 .. 之類試圖跳出使用者資料夾的路徑
    if (!storagePath || storagePath.includes("..")) return jsonError(404, "找不到圖片。");

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

    // 直接串流 Supabase 回傳的 Blob，避免 NextResponse(Uint8Array) 在 Vercel 上經過
    // 文字編碼路徑，把 JPEG 的 0xff 等位元改寫成 UTF-8 replacement character（ef bf bd）。
    // 不手動設定 Content-Length，交由串流回應處理，亦避免完整圖片先進入 function buffer。
    return new Response(data.stream(), {
      status: 200,
      headers: {
        "Content-Type": data.type || "image/jpeg",
        // 圖檔以 uuid 命名、內容不變，可讓瀏覽器私有快取；private 確保不落入共用快取
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
