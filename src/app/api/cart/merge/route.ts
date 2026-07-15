import { NextResponse } from "next/server";
import { mergeGuestCartForUser } from "@/lib/cart";
import { cartApiError } from "@/lib/cart-api";
import { isUuid, parseStrictCartItems } from "@/lib/cart-storage";
import { requireUser } from "@/lib/user";

export async function POST(request: Request) {
  try {
    const userId = (await requireUser()).id;
    const body = (await request.json().catch(() => null)) as {
      guestCartId?: unknown;
      items?: unknown;
    } | null;
    const items = parseStrictCartItems(body?.items);
    if (!isUuid(body?.guestCartId) || items === null) {
      return Response.json({ status: "failed", message: "本機購物車資料格式不正確。" }, { status: 400 });
    }
    return NextResponse.json(await mergeGuestCartForUser(userId, body.guestCartId, items));
  } catch (error) {
    return cartApiError(error);
  }
}
