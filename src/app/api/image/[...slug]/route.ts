// GET /api/image/{bucket}/{path...} — 私有圖片轉發（人物照 / 試穿結果圖）
//
// 為什麼存在：人物照與結果圖存在私有 bucket，前端原本拿的是 supabase.co 的短期 signed URL。
// 但有些網路（飯店 / 公司 / 部分地區）會封鎖 supabase.co，瀏覽器直連就拿不到圖（顯示破圖）。
// 改由後端在伺服器端向 Supabase 取圖、再從「本站網域」吐回給瀏覽器，即可繞過這類封鎖
// （瀏覽器只跟本站溝通，就像站內靜態圖一樣）。
//
// 隱私仍維持：這裡以 cookie 使用者驗證「只能讀自己的圖」——路徑必須以 {userId}/ 開頭，
// 與 try-on 各處的所有權檢查一致。相較原本「任何人拿到 signed URL 都能看 1 小時」，
// 這個做法反而更嚴（沒有本人的 cookie 就讀不到）。
import { NextResponse } from "next/server";
import { getUserId } from "@/lib/user";
import { getSupabaseAdmin, PERSON_BUCKET, RESULT_BUCKET } from "@/lib/supabase";
import { jsonError, errorMessage } from "@/lib/http";

type RouteParams = { params: Promise<{ slug: string[] }> };

// 只開放這兩個私有 bucket，避免這個端點被拿去讀 storage 內其他內容
const ALLOWED_BUCKETS = new Set<string>([PERSON_BUCKET, RESULT_BUCKET]);

export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { slug } = await params;
    // slug = [bucket, ...pathParts]；至少要有 bucket + 一段路徑
    if (!slug || slug.length < 2) return jsonError(404, "找不到圖片。");

    const [bucket, ...rest] = slug;
    if (!ALLOWED_BUCKETS.has(bucket)) return jsonError(404, "找不到圖片。");

    const storagePath = rest.join("/");
    // 路徑跳脫防護：拒絕 .. 之類試圖跳出使用者資料夾的路徑
    if (!storagePath || storagePath.includes("..")) return jsonError(404, "找不到圖片。");

    // 所有權：路徑必須以 {userId}/ 開頭，確保只能讀自己的圖。
    // 一律回 404（而非 403），不洩漏「這張圖是否存在」。
    const userId = await getUserId();
    if (!userId || !storagePath.startsWith(`${userId}/`)) {
      return jsonError(404, "找不到圖片。");
    }

    const supabase = getSupabaseAdmin();
    const { data, error } = await supabase.storage.from(bucket).download(storagePath);
    if (error || !data) return jsonError(404, "找不到圖片。");

    const bytes = new Uint8Array(await data.arrayBuffer());
    return new NextResponse(bytes, {
      status: 200,
      headers: {
        "Content-Type": data.type || "image/jpeg",
        "Content-Length": String(bytes.byteLength),
        // 圖檔以 uuid 命名、內容不變，可讓瀏覽器私有快取；private 確保不落入共用快取
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (e) {
    return jsonError(500, errorMessage(e));
  }
}
