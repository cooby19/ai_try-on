import { NextResponse } from "next/server";
import { resolveGuestCart } from "@/lib/cart";
import { cartApiError } from "@/lib/cart-api";
import { parseStrictCartItems } from "@/lib/cart-storage";

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
    const items = parseStrictCartItems(body?.items);
    if (items === null) {
      return Response.json({ status: "failed", message: "本機購物車資料格式不正確。" }, { status: 400 });
    }
    return NextResponse.json(await resolveGuestCart(items));
  } catch (error) {
    return cartApiError(error);
  }
}
