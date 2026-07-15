import { NextResponse } from "next/server";
import { getCartView } from "@/lib/cart";
import { cartApiError } from "@/lib/cart-api";
import { requireUser } from "@/lib/user";

export async function GET() {
  try {
    const userId = (await requireUser()).id;
    return NextResponse.json(await getCartView(userId));
  } catch (error) {
    return cartApiError(error);
  }
}
