import sharp from "sharp";

// Vercel Function 的 response payload 上限是 4.5 MB；以 4 MiB 為目標，
// 替 HTTP headers 與平台計算差異保留約 300 KB 的安全空間。
export const MAX_IMAGE_RESPONSE_BYTES = 4 * 1024 * 1024;

export type SafeImagePayload = {
  buffer: Buffer;
  contentType: "image/jpeg";
  optimized: boolean;
};

// 超過安全值時才重新編碼。先降低 JPEG 品質；若仍太大，再依實際超出比例縮小尺寸。
// 最後以 1024px / q60 收斂，確保高複雜度或放大後圖片也不會撞上平台 response 上限。
export async function fitImageToResponseLimit(
  input: Buffer,
  maxBytes = MAX_IMAGE_RESPONSE_BYTES
): Promise<SafeImagePayload> {
  if (input.length <= maxBytes) {
    return { buffer: input, contentType: "image/jpeg", optimized: false };
  }

  const source = sharp(input, { failOn: "error" }).rotate();
  const metadata = await source.metadata();
  if (!metadata.width || !metadata.height) {
    throw new Error("圖片缺少有效尺寸，無法壓縮到安全大小。");
  }

  let width = metadata.width;
  let height = metadata.height;
  const qualities = [88, 82, 76, 70, 64];

  for (const quality of qualities) {
    const output = await source
      .clone()
      .resize({ width, height, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    if (output.length <= maxBytes) {
      return { buffer: output, contentType: "image/jpeg", optimized: true };
    }

    // JPEG 位元組數大致隨像素數變化；平方根可把 byte 比例換算成邊長比例。
    const scale = Math.min(0.9, Math.sqrt(maxBytes / output.length) * 0.9);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }

  const finalOutput = await source
    .clone()
    .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 60, mozjpeg: true })
    .toBuffer();
  if (finalOutput.length > maxBytes) {
    throw new Error("圖片壓縮後仍超過安全回傳大小。");
  }
  return { buffer: finalOutput, contentType: "image/jpeg", optimized: true };
}
