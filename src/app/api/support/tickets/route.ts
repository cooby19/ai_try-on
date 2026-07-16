import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import { createSupportTicket, listSupportTicketsForUser } from "@/lib/support";
import { requireUser } from "@/lib/user";

export async function GET() {
  try {
    const user = await requireUser();
    return NextResponse.json(await listSupportTicketsForUser(user.id));
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}

export async function POST(request: Request) {
  try {
    const user = await requireUser();
    if (!user.email) return NextResponse.json({ status: "failed", message: "帳戶沒有可用 Email。" }, { status: 422 });
    const body = await request.json().catch(() => null);
    const ticket = await createSupportTicket(user.id, user.email, body);
    return NextResponse.json(ticket, { status: 201 });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}
