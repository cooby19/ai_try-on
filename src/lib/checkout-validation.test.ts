import { describe, expect, it } from "vitest";
import {
  normalizePhone,
  validateRecipientInput,
  validateSavedAddressInput,
  validateShippingMethodCode,
} from "./checkout-validation";

describe("結帳收件資料驗證", () => {
  it("正規化並接受台灣手機與完整收件資料", () => {
    expect(normalizePhone("0912-345-678")).toBe("0912345678");
    expect(validateRecipientInput({
      recipientName: " 王小明 ",
      recipientPhone: "+886 912 345 678",
      recipientAddress: "台北市信義區市府路 1 號",
    })).toEqual({
      ok: true,
      value: {
        recipientName: "王小明",
        recipientPhone: "+886912345678",
        recipientAddress: "台北市信義區市府路 1 號",
      },
    });
  });

  it.each([
    { recipientName: "", recipientPhone: "0912345678", recipientAddress: "台北市信義區市府路 1 號" },
    { recipientName: "王小明", recipientPhone: "12345", recipientAddress: "台北市信義區市府路 1 號" },
    { recipientName: "王小明", recipientPhone: "0912345678", recipientAddress: "太短" },
  ])("拒絕不完整或格式錯誤的收件資料", (input) => {
    expect(validateRecipientInput(input)).toMatchObject({ ok: false });
  });

  it("驗證地址名稱與運送方式代碼", () => {
    expect(validateSavedAddressInput({
      label: "公司",
      recipientName: "王小明",
      recipientPhone: "0912345678",
      recipientAddress: "台北市信義區市府路 1 號",
    })).toMatchObject({ ok: true });
    expect(validateSavedAddressInput({
      label: "",
      recipientName: "王小明",
      recipientPhone: "0912345678",
      recipientAddress: "台北市信義區市府路 1 號",
    })).toMatchObject({ ok: false });
    expect(validateShippingMethodCode("standard_delivery")).toEqual({ ok: true, value: "standard_delivery" });
    expect(validateShippingMethodCode("<script>")).toMatchObject({ ok: false });
  });
});
