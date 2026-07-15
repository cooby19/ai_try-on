import "server-only";

import { AppError } from "./http";
import { getSupabaseAdmin } from "./supabase";
import type {
  CartItemView,
  CartUnavailableReason,
  CartView,
  LocalCartItem,
} from "./types";

interface CartDatabaseRow {
  quantity: number;
  created_at: string;
  product_variants: {
    id: string;
    product_id: string;
    size: string;
    stock_quantity: number;
    is_active: boolean;
    products: {
      id: string;
      name: string;
      price: number | string;
      image_url: string;
      is_active: boolean;
    };
  };
}

type VariantDatabaseRow = CartDatabaseRow["product_variants"];

interface AvailableInventoryRow {
  variant_id: string;
  available_quantity: number | string;
}

interface CartRpcResult {
  status?: string;
  quantity?: number;
  maxQuantity?: number;
  adjusted?: boolean | number;
  skipped?: number;
  alreadyMerged?: boolean;
}

export class CartError extends AppError {
  constructor(status: number, message: string, public readonly maxQuantity?: number) {
    super(status, message);
    this.name = "CartError";
  }
}

export function emptyCart(notices: string[] = []): CartView {
  return { items: [], itemCount: 0, subtotal: 0, notices };
}

function unavailableReason(variant: VariantDatabaseRow, availableQuantity: number): CartUnavailableReason | null {
  if (!variant.products.is_active) return "product_inactive";
  if (!variant.is_active) return "variant_inactive";
  if (availableQuantity < 1) return "out_of_stock";
  return null;
}

function toCartItem(variant: VariantDatabaseRow, quantity: number, availableQuantity: number): CartItemView {
  const unitPrice = Number(variant.products.price);
  const maxQuantity = Math.min(99, Math.max(0, availableQuantity));
  const reason = unavailableReason(variant, availableQuantity);
  return {
    variantId: variant.id,
    productId: variant.product_id,
    name: variant.products.name,
    imageUrl: variant.products.image_url,
    size: variant.size,
    unitPrice,
    quantity,
    maxQuantity,
    available: reason === null,
    unavailableReason: reason,
    lineSubtotal: reason === null ? unitPrice * quantity : 0,
  };
}

async function getAvailableInventory(variantIds: string[]): Promise<Map<string, number>> {
  if (!variantIds.length) return new Map();
  const { data, error } = await getSupabaseAdmin().rpc("get_available_inventory", {
    p_variant_ids: variantIds,
  });
  if (error) throw new CartError(500, `可售庫存讀取失敗：${error.message}`);
  return new Map((data as AvailableInventoryRow[] | null ?? []).map((row) => [
    row.variant_id,
    Math.max(0, Number(row.available_quantity)),
  ]));
}

export function buildCartView(items: CartItemView[], notices: string[] = []): CartView {
  return {
    items,
    itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    subtotal: items.reduce((sum, item) => sum + item.lineSubtotal, 0),
    notices,
  };
}

async function findCartId(userId: string): Promise<string | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("carts")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle<{ id: string }>();
  if (error) throw new CartError(500, `購物車讀取失敗：${error.message}`);
  return data?.id ?? null;
}

export async function getCartView(userId: string, notices: string[] = []): Promise<CartView> {
  const supabase = getSupabaseAdmin();
  const { data: reconciled, error: reconcileError } = await supabase.rpc("reconcile_cart_stock", {
    p_user_id: userId,
  });
  if (reconcileError) throw new CartError(500, `購物車庫存同步失敗：${reconcileError.message}`);
  if (Number(reconciled) > 0) notices.push("部分商品數量已依目前庫存調整。");

  const cartId = await findCartId(userId);
  if (!cartId) return emptyCart(notices);

  const { data, error } = await supabase
    .from("cart_items")
    .select(`
      quantity,
      created_at,
      product_variants!inner (
        id, product_id, size, stock_quantity, is_active,
        products!inner (id, name, price, image_url, is_active)
      )
    `)
    .eq("cart_id", cartId)
    .order("created_at", { ascending: true })
    .returns<CartDatabaseRow[]>();
  if (error) throw new CartError(500, `購物車讀取失敗：${error.message}`);

  const availableByVariant = await getAvailableInventory((data ?? []).map((row) => row.product_variants.id));
  return buildCartView((data ?? []).map((row) => toCartItem(
    row.product_variants,
    Number(row.quantity),
    availableByVariant.get(row.product_variants.id) ?? 0
  )), notices);
}

export async function resolveGuestCart(items: LocalCartItem[]): Promise<CartView> {
  if (!items.length) return emptyCart();
  const supabase = getSupabaseAdmin();
  const variantIds = items.map((item) => item.variantId);
  const { data, error } = await supabase
    .from("product_variants")
    .select(`
      id, product_id, size, stock_quantity, is_active,
      products!inner (id, name, price, image_url, is_active)
    `)
    .in("id", variantIds)
    .returns<VariantDatabaseRow[]>();
  if (error) throw new CartError(500, `商品資料讀取失敗：${error.message}`);

  const variants = new Map((data ?? []).map((variant) => [variant.id, variant]));
  const availableByVariant = await getAvailableInventory([...variants.keys()]);
  const notices: string[] = [];
  const viewItems: CartItemView[] = [];
  for (const item of items) {
    const variant = variants.get(item.variantId);
    if (!variant) {
      notices.push("一筆不存在的商品已從本機購物車略過。");
      continue;
    }
    const availableQuantity = availableByVariant.get(variant.id) ?? 0;
    const maxQuantity = Math.min(99, Math.max(0, availableQuantity));
    const quantity = maxQuantity > 0 ? Math.min(item.quantity, maxQuantity) : item.quantity;
    if (quantity !== item.quantity) notices.push(`${variant.products.name}（${variant.size}）已依庫存調整數量。`);
    viewItems.push(toCartItem(variant, quantity, availableQuantity));
  }
  return buildCartView(viewItems, notices);
}

function assertRpcSuccess(result: CartRpcResult | null, fallback: string): CartRpcResult {
  switch (result?.status) {
    case "success":
      return result;
    case "not_found":
      throw new CartError(404, "找不到這個商品規格。");
    case "unavailable":
      throw new CartError(409, "這個商品規格目前無法購買。", result.maxQuantity);
    case "exceeds_stock":
      throw new CartError(422, `目前最多只能購買 ${result.maxQuantity ?? 0} 件。`, result.maxQuantity);
    case "invalid_quantity":
    case "invalid_input":
      throw new CartError(400, "購物車資料格式不正確。");
    case "invalid_user":
      throw new CartError(401, "請先登入後再操作購物車。");
    default:
      throw new CartError(500, fallback);
  }
}

export async function addCartItemForUser(userId: string, variantId: string, quantity: number): Promise<CartView> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("add_cart_item", {
    p_user_id: userId,
    p_variant_id: variantId,
    p_quantity: quantity,
  });
  if (error) throw new CartError(500, `加入購物車失敗：${error.message}`);
  const result = assertRpcSuccess(data as CartRpcResult | null, "加入購物車失敗。");
  const notices = result.adjusted ? [`已達庫存上限，數量調整為 ${result.quantity} 件。`] : [];
  return getCartView(userId, notices);
}

export async function setCartItemForUser(userId: string, variantId: string, quantity: number): Promise<CartView> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("set_cart_item_quantity", {
    p_user_id: userId,
    p_variant_id: variantId,
    p_quantity: quantity,
  });
  if (error) throw new CartError(500, `更新購物車失敗：${error.message}`);
  assertRpcSuccess(data as CartRpcResult | null, "更新購物車失敗。");
  return getCartView(userId);
}

export async function deleteCartItemForUser(userId: string, variantId: string): Promise<CartView> {
  const supabase = getSupabaseAdmin();
  const cartId = await findCartId(userId);
  if (!cartId) throw new CartError(404, "找不到這筆購物車商品。");
  const { data, error } = await supabase
    .from("cart_items")
    .delete()
    .eq("cart_id", cartId)
    .eq("variant_id", variantId)
    .select("id")
    .returns<{ id: string }[]>();
  if (error) throw new CartError(500, `移除購物車商品失敗：${error.message}`);
  if (!data?.length) throw new CartError(404, "找不到這筆購物車商品。");
  await supabase.from("carts").update({ updated_at: new Date().toISOString() }).eq("id", cartId);
  return getCartView(userId);
}

export async function mergeGuestCartForUser(
  userId: string,
  guestCartId: string,
  items: LocalCartItem[]
): Promise<CartView> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.rpc("merge_guest_cart", {
    p_user_id: userId,
    p_guest_cart_id: guestCartId,
    p_items: items,
  });
  if (error) throw new CartError(500, `購物車合併失敗：${error.message}`);
  const result = assertRpcSuccess(data as CartRpcResult | null, "購物車合併失敗。");
  const notices: string[] = [];
  if (Number(result.adjusted) > 0) notices.push("部分商品合併後已依庫存上限調整數量。");
  if (Number(result.skipped) > 0) notices.push("部分下架、缺貨或不存在的商品未合併至帳號。");
  return getCartView(userId, notices);
}
