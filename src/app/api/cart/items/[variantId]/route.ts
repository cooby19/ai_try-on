import { NextResponse } from "next/server";
import { deleteCartItemForUser, setCartItemForUser } from "@/lib/cart";
import { cartApiError } from "@/lib/cart-api";
import { isUuid } from "@/lib/cart-storage";
import { requireUser } from "@/lib/user";

type Context = { params: Promise<{ variantId: string }> };

export async function PATCH(request: Request, { params }: Context) {
  try {
    const userId = (await requireUser()).id;
    const { variantId } = await params;
    const body = (await request.json().catch(() => null)) as { quantity?: unknown } | null;
    const quantity = body?.quantity;
    if (!isUuid(variantId) || !Number.isInteger(quantity) || Number(quantity) < 1 || Number(quantity) > 99) {
      return Response.json({ status: "failed", message: "商品規格或數量格式不正確。" }, { status: 400 });
    }
    return NextResponse.json(await setCartItemForUser(userId, variantId, Number(quantity)));
  } catch (error) {
    return cartApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const userId = (await requireUser()).id;
    const { variantId } = await params;
    if (!isUuid(variantId)) {
      return Response.json({ status: "failed", message: "商品規格格式不正確。" }, { status: 400 });
    }
    return NextResponse.json(await deleteCartItemForUser(userId, variantId));
  } catch (error) {
    return cartApiError(error);
  }
}
