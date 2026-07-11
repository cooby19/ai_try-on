import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fitImageToResponseLimit, MAX_IMAGE_RESPONSE_BYTES } from "@/lib/image-payload";

function makePseudoRandomBytes(length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let state = 0x12345678;
  for (let index = 0; index < length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    bytes[index] = state & 0xff;
  }
  return bytes;
}

describe("fitImageToResponseLimit", () => {
  it("安全大小內不重新編碼", async () => {
    const input = await sharp({
      create: { width: 320, height: 480, channels: 3, background: "#888" },
    })
      .jpeg()
      .toBuffer();

    const result = await fitImageToResponseLimit(input);
    expect(result.optimized).toBe(false);
    expect(result.buffer).toBe(input);
    expect(result.buffer.length).toBeLessThanOrEqual(MAX_IMAGE_RESPONSE_BYTES);
  });

  it("高複雜度的大圖會壓縮到 4 MiB 安全目標內", async () => {
    const width = 2600;
    const height = 2600;
    const input = await sharp(makePseudoRandomBytes(width * height * 3), {
      raw: { width, height, channels: 3 },
    })
      .jpeg({ quality: 100 })
      .toBuffer();
    expect(input.length).toBeGreaterThan(MAX_IMAGE_RESPONSE_BYTES);

    const result = await fitImageToResponseLimit(input);
    expect(result.optimized).toBe(true);
    expect(result.contentType).toBe("image/jpeg");
    expect(result.buffer.length).toBeLessThanOrEqual(MAX_IMAGE_RESPONSE_BYTES);
    expect((await sharp(result.buffer).metadata()).format).toBe("jpeg");
  });
});
