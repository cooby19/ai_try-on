import "server-only";

import { validateRecipientInput, validateShippingMethodCode } from "./checkout-validation";
import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import type { OrderStatus, OrderView, ShippingMethod } from "./types";

interface ShippingMethodRow {
  code: string;
  name: string;
  fee: number | string;
}

interface OrderItemRow {
  id: string;
  product_id: string;
  variant_id: string;
  product_name: string;
  variant_size: string;
  image_url: string;
  unit_price: number | string;
  quantity: number;
  line_subtotal: number | string;
}

interface OrderRow {
  id: string;
  order_number: string;
  status: OrderStatus;
  recipient_name: string;
  recipient_phone: string;
  recipient_address: string;
  shipping_method_code: string;
  shipping_method_name: string;
  shipping_fee: number | string;
  subtotal: number | string;
  total: number | string;
  created_at: string;
  order_items: OrderItemRow[];
}

interface CreateOrderResult {
  status?: string;
  orderId?: string;
  orderNumber?: string;
  reused?: boolean;
  availableQuantity?: number;
}

export class OrderError extends AppError {
  constructor(status: number, message: string) {
    super(status, message);
    this.name = "OrderError";
  }
}

function toOrderView(row: OrderRow): OrderView {
  return {
    id: row.id,
    orderNumber: row.order_number,
    status: row.status,
    recipientName: row.recipient_name,
    recipientPhone: row.recipient_phone,
    recipientAddress: row.recipient_address,
    shippingMethodCode: row.shipping_method_code,
    shippingMethodName: row.shipping_method_name,
    shippingFee: Number(row.shipping_fee),
    subtotal: Number(row.subtotal),
    total: Number(row.total),
    createdAt: row.created_at,
    items: row.order_items.map((item) => ({
      id: item.id,
      productId: item.product_id,
      variantId: item.variant_id,
      productName: item.product_name,
      variantSize: item.variant_size,
      imageUrl: item.image_url,
      unitPrice: Number(item.unit_price),
      quantity: Number(item.quantity),
      lineSubtotal: Number(item.line_subtotal),
    })),
  };
}

export async function getShippingMethods(): Promise<ShippingMethod[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("shipping_methods")
    .select("code, name, fee")
    .eq("is_active", true)
    .order("fee")
    .returns<ShippingMethodRow[]>();
  if (error) throw new OrderError(500, `運送方式讀取失敗：${error.message}`);
  return (data ?? []).map((method) => ({
    code: method.code,
    name: method.name,
    fee: Number(method.fee),
  }));
}

export async function createOrderFromCart(userId: string, input: unknown): Promise<{ orderId: string; orderNumber: string; reused: boolean }> {
  if (!input || typeof input !== "object") throw new OrderError(400, "結帳資料格式不正確。" );
  const body = input as Record<string, unknown>;
  const recipient = validateRecipientInput(body);
  if (!recipient.ok) throw new OrderError(400, recipient.message);
  const shippingMethod = validateShippingMethodCode(body.shippingMethodCode);
  if (!shippingMethod.ok) throw new OrderError(400, shippingMethod.message);
  if (typeof body.idempotencyKey !== "string" || !isUuid(body.idempotencyKey)) {
    throw new OrderError(400, "結帳請求識別碼不正確，請重新送出。" );
  }

  const { data, error } = await getSupabaseAdmin().rpc("create_order_from_cart", {
    p_user_id: userId,
    p_shipping_method_code: shippingMethod.value,
    p_recipient_name: recipient.value.recipientName,
    p_recipient_phone: recipient.value.recipientPhone,
    p_recipient_address: recipient.value.recipientAddress,
    p_idempotency_key: body.idempotencyKey,
  });
  if (error) throw new OrderError(500, `訂單建立失敗：${error.message}`);

  const result = data as CreateOrderResult | null;
  switch (result?.status) {
    case "success":
      if (!result.orderId || !result.orderNumber) throw new OrderError(500, "訂單建立回應不完整。" );
      return { orderId: result.orderId, orderNumber: result.orderNumber, reused: Boolean(result.reused) };
    case "invalid_user":
      throw new OrderError(401, "請先登入後再結帳。" );
    case "invalid_input":
      throw new OrderError(400, "收件資料或運送方式格式不正確。" );
    case "shipping_method_unavailable":
      throw new OrderError(422, "選擇的運送方式目前不可用，請重新選擇。" );
    case "empty_cart":
      throw new OrderError(409, "購物車是空的，無法建立訂單。" );
    case "cart_unavailable":
      throw new OrderError(409, "購物車內有已下架或停售商品，請回購物車調整。" );
    case "insufficient_stock":
      throw new OrderError(409, `部分商品庫存不足（目前可購 ${result.availableQuantity ?? 0} 件），請回購物車調整。`);
    default:
      throw new OrderError(500, "訂單建立失敗，請稍後再試。" );
  }
}

export async function getOrderForUser(userId: string, orderId: string): Promise<OrderView | null> {
  if (!isUuid(orderId)) return null;
  const { data, error } = await getSupabaseAdmin()
    .from("orders")
    .select(`
      id, order_number, status, recipient_name, recipient_phone, recipient_address,
      shipping_method_code, shipping_method_name, shipping_fee, subtotal, total, created_at,
      order_items (
        id, product_id, variant_id, product_name, variant_size, image_url,
        unit_price, quantity, line_subtotal
      )
    `)
    .eq("id", orderId)
    .eq("user_id", userId)
    .maybeSingle<OrderRow>();
  if (error) throw new OrderError(500, `訂單讀取失敗：${error.message}`);
  return data ? toOrderView(data) : null;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
