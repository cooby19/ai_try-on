// validation.ts 的回歸保護：上傳檢查是唯一擋在「使用者檔案 → 花錢的 AI API」
// 之間的關卡，這裡釘死格式白名單、8MB 與 320px 的邊界，以及錯誤訊息必須可操作。
// normalizePersonImage 直接用真的 sharp 動態產圖（專案本來就依賴 sharp），
// 不 mock 影像處理，測到的才是真實的解碼／縮圖行為。
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  ALLOWED_MIME_TYPES,
  MAX_FILE_SIZE_BYTES,
  MIN_IMAGE_WIDTH,
  TARGET_MAX_WIDTH,
  normalizePersonImage,
  validateFileMeta,
} from "@/lib/validation";

// 產生指定寬度的測試圖（純色即可，檢查的是尺寸與格式，不是內容）
async function makeImage(
  width: number,
  format: "jpeg" | "png" = "jpeg"
): Promise<Buffer> {
  const image = sharp({
    create: {
      width,
      height: Math.round(width * 1.5), // 半身照通常是直式，比例不影響檢查邏輯
      channels: 3,
      background: { r: 180, g: 140, b: 120 },
    },
  });
  return format === "png" ? image.png().toBuffer() : image.jpeg().toBuffer();
}

describe("validateFileMeta：格式白名單", () => {
  it.each(ALLOWED_MIME_TYPES)("允許 %s", (mime) => {
    expect(validateFileMeta({ type: mime, size: 1024 })).toEqual({ ok: true });
  });

  it.each(["image/gif", "image/bmp", "application/pdf", "text/html"])(
    "拒絕 %s，訊息告知支援的格式",
    (mime) => {
      // GIF/PDF 等不在白名單：訊息要引導使用者「另存成支援格式」，不是丟技術錯誤
      expect(validateFileMeta({ type: mime, size: 1024 })).toMatchObject({
        ok: false,
        message: expect.stringContaining("JPG"),
      });
    }
  );
});

describe("validateFileMeta：大小邊界", () => {
  it("剛好 8MB 應通過（上限是「超過」才拒絕）", () => {
    expect(
      validateFileMeta({ type: "image/jpeg", size: MAX_FILE_SIZE_BYTES })
    ).toEqual({ ok: true });
  });

  it("8MB + 1 byte 拒絕，訊息建議先縮小照片", () => {
    expect(
      validateFileMeta({ type: "image/jpeg", size: MAX_FILE_SIZE_BYTES + 1 })
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("8MB"),
    });
  });

  it("空檔案（size = 0）拒絕", () => {
    expect(validateFileMeta({ type: "image/png", size: 0 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("重新選擇"),
    });
  });
});

describe("normalizePersonImage：解析度邊界", () => {
  it(`寬度低於 ${MIN_IMAGE_WIDTH}px 拒絕，訊息含最低解析度`, async () => {
    const result = await normalizePersonImage(await makeImage(200));
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining(`${MIN_IMAGE_WIDTH}`),
    });
  });

  it(`寬度剛好 ${MIN_IMAGE_WIDTH}px 應通過（下限是「小於」才拒絕）`, async () => {
    const result = await normalizePersonImage(await makeImage(MIN_IMAGE_WIDTH));
    expect(result.ok).toBe(true);
  });
});

describe("normalizePersonImage：統一輸出規格", () => {
  it(`寬圖會被壓到 ${TARGET_MAX_WIDTH}px 並轉成 JPEG`, async () => {
    // 壓縮是成本控管的一環：送給 VTO API 的圖太大會拖慢生成、放大流量
    const result = await normalizePersonImage(await makeImage(2000));
    if (!result.ok) throw new Error(`預期通過，卻被拒絕：${result.message}`);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(TARGET_MAX_WIDTH);
    expect(meta.format).toBe("jpeg");
  });

  it("介於下限與目標寬度之間的圖不會被放大（withoutEnlargement）", async () => {
    // 放大只會產生模糊像素、增加檔案大小，對生成品質沒有幫助
    const result = await normalizePersonImage(await makeImage(600));
    if (!result.ok) throw new Error(`預期通過，卻被拒絕：${result.message}`);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.width).toBe(600);
    expect(meta.format).toBe("jpeg");
  });

  it("PNG 輸入也統一轉成 JPEG（後端一律以 JPEG 存放人物照）", async () => {
    const result = await normalizePersonImage(await makeImage(800, "png"));
    if (!result.ok) throw new Error(`預期通過，卻被拒絕：${result.message}`);
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe("jpeg");
  });
});

describe("normalizePersonImage：無法解碼", () => {
  it("非圖片內容拒絕，訊息引導重新上傳", async () => {
    // mime type 可以造假，真正的保險是 sharp 實際解碼失敗時要好好報錯
    const result = await normalizePersonImage(
      Buffer.from("這不是圖片，只是一串文字 bytes")
    );
    expect(result).toMatchObject({
      ok: false,
      message: expect.stringContaining("無法辨識"),
    });
  });
});
