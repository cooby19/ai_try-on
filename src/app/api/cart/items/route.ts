import { NextResponse } from "next/server";
import { addCartItemForUser } from "@/lib/cart";
import { cartApiError } from "@/lib/cart-api";
import { isUuid } from "@/lib/cart-storage";
import { requireUser } from "@/lib/user";

export async function POST(request: Request) {
  try {
    const userId = (await requireUser()).id;
    const body = (await request.json().catch(() => null)) as {
      variantId?: unknown;
      quantity?: unknown;
    } | null;
    const quantity = body?.quantity ?? 1;
    if (!isUuid(body?.variantId) || !Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 99) {
      return Response.json({ status: "failed", message: "商品規格或數量格式不正確。" }, { status: 400 });
    }
    return NextResponse.json(await addCartItemForUser(userId, body.variantId, Number(quantity)));
  } catch (error) {
    return cartApiError(error);
  }
}
