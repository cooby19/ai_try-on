import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import { simulateMockPaymentForUser } from "@/lib/mock-payments";
import { requireUser } from "@/lib/user";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orderId: string }> }
) {
  try {
    const userId = (await requireUser()).id;
    const { orderId } = await params;
    const body = (await request.json().catch(() => null)) as { outcome?: unknown } | null;
    const result = await simulateMockPaymentForUser(userId, orderId, body?.outcome);
    return NextResponse.json({ status: "success", ...result });
  } catch (error) {
    return NextResponse.json(
      { status: "failed", message: errorMessage(error) },
      { status: errorStatus(error) }
    );
  }
}
