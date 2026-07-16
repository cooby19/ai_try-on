import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import { requestOrderOperation } from "@/lib/order-operations";
import { requireUser } from "@/lib/user";

export async function POST(request: Request, { params }: { params: Promise<{ orderId: string }> }) {
  try {
    const user = await requireUser();
    const { orderId } = await params;
    const body = (await request.json().catch(() => null)) as { reason?: unknown } | null;
    const result = await requestOrderOperation(user.id, orderId, "cancellation", body?.reason);
    return NextResponse.json({ status: "success", ...result });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}
