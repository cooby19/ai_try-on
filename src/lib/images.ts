// 圖片來源處理工具：把「站內路徑（/garments/xxx.svg）」或「http(s) URL」
// 統一載入成 PNG buffer，供 VTO provider 轉 base64 使用。
import { promises as fs } from "fs";
import path from "path";
import sharp from "sharp";

export const GARMENT_IMAGE_PREPROCESSING_VERSION = "garment-image-v1" as const;
export const GARMENT_IMAGE_MAX_WIDTH = 1024 as const;

export async function loadImageAsPngBuffer(source: string): Promise<Buffer> {
  let raw: Buffer;
  if (source.startsWith("http://") || source.startsWith("https://")) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`無法下載圖片：${source}（HTTP ${res.status}）`);
    raw = Buffer.from(await res.arrayBuffer());
  } else {
    // 站內路徑 → 直接讀 public/ 目錄，避免依賴對外網址
    const safePath = path.normalize(source).replace(/^([/\\])+/, "");
    const filePath = path.join(process.cwd(), "public", safePath);
    if (!filePath.startsWith(path.join(process.cwd(), "public"))) {
      throw new Error("不合法的圖片路徑");
    }
    raw = await fs.readFile(filePath);
  }
  // 統一轉 PNG（SVG 也會在這裡被點陣化）
  return sharp(raw)
    .resize({ width: GARMENT_IMAGE_MAX_WIDTH, withoutEnlargement: true })
    .png()
    .toBuffer();
}

export function toBase64DataUri(buffer: Buffer, mime = "image/png"): string {
  return `data:${mime};base64,${buffer.toString("base64")}`;
}
