import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import { createOrderFromCart } from "@/lib/orders";
import { requireUser } from "@/lib/user";

export async function POST(request: Request) {
  try {
    const userId = (await requireUser()).id;
    const body = await request.json().catch(() => null);
    return NextResponse.json(await createOrderFromCart(userId, body), { status: 201 });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}
