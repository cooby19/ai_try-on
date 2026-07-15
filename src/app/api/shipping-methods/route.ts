import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import { getShippingMethods } from "@/lib/orders";
import { requireUser } from "@/lib/user";

export async function GET() {
  try {
    await requireUser();
    return NextResponse.json(await getShippingMethods());
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}
