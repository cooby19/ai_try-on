export interface RecipientInput {
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
}

export interface SavedAddressInput extends RecipientInput {
  label: string;
}

export type CheckoutValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

function stringField(value: unknown): string | null {
  return typeof value === "string" ? value.trim() : null;
}

export function normalizePhone(value: string): string {
  return value.replace(/[\s()-]/g, "");
}

export function validateRecipientInput(input: unknown): CheckoutValidationResult<RecipientInput> {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "請完整填寫收件人資料。" };
  }
  const record = input as Record<string, unknown>;
  const recipientName = stringField(record.recipientName);
  const rawPhone = stringField(record.recipientPhone);
  const recipientAddress = stringField(record.recipientAddress);

  if (!recipientName || recipientName.length > 80) {
    return { ok: false, message: "請填寫 1 至 80 字的收件人姓名。" };
  }
  const recipientPhone = rawPhone ? normalizePhone(rawPhone) : "";
  if (!/^(?:09\d{8}|\+8869\d{8})$/.test(recipientPhone)) {
    return { ok: false, message: "請輸入有效的台灣手機號碼，例如 0912345678。" };
  }
  if (!recipientAddress || recipientAddress.length < 5 || recipientAddress.length > 300) {
    return { ok: false, message: "請填寫 5 至 300 字的完整收件地址。" };
  }
  return { ok: true, value: { recipientName, recipientPhone, recipientAddress } };
}

export function validateSavedAddressInput(input: unknown): CheckoutValidationResult<SavedAddressInput> {
  if (!input || typeof input !== "object") {
    return { ok: false, message: "地址資料格式不正確。" };
  }
  const label = stringField((input as Record<string, unknown>).label);
  if (!label || label.length > 40) {
    return { ok: false, message: "請填寫 1 至 40 字的地址名稱。" };
  }
  const recipient = validateRecipientInput(input);
  if (!recipient.ok) return recipient;
  return { ok: true, value: { label, ...recipient.value } };
}

export function validateShippingMethodCode(value: unknown): CheckoutValidationResult<string> {
  if (typeof value !== "string" || !/^[a-z0-9_]{1,40}$/.test(value)) {
    return { ok: false, message: "請選擇有效的運送方式。" };
  }
  return { ok: true, value };
}
