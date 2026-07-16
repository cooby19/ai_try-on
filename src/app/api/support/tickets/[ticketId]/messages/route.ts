import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import { addCustomerSupportMessage } from "@/lib/support";
import { requireUser } from "@/lib/user";

export async function POST(request: Request, { params }: { params: Promise<{ ticketId: string }> }) {
  try {
    const user = await requireUser();
    const { ticketId } = await params;
    const body = (await request.json().catch(() => null)) as { message?: unknown } | null;
    await addCustomerSupportMessage(user.id, ticketId, body?.message);
    return NextResponse.json({ status: "success" });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}
