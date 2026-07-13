// 瀏覽器直接把檔案送到 Supabase Storage 的 signed upload URL。
// 不建立前端 Supabase client，因此不需要把 service role 或 anon key 打進 bundle。
export async function uploadFileToSignedUrl(signedUrl: string, file: File): Promise<void> {
  const formData = new FormData();
  formData.append("cacheControl", "3600");
  // storage-js 對 Blob/File 使用空欄位名稱；沿用相同 wire format。
  formData.append("", file);
  const response = await fetch(signedUrl, {
    method: "PUT",
    headers: { "x-upsert": "false" },
    body: formData,
  });
  if (!response.ok) {
    throw new Error(`照片直傳失敗（HTTP ${response.status}）`);
  }
}
