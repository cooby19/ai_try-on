import { NextResponse } from "next/server";
import { createAddressForUser, getAddressesForUser } from "@/lib/addresses";
import { errorMessage, errorStatus } from "@/lib/http";
import { requireUser } from "@/lib/user";

export async function GET() {
  try {
    const userId = (await requireUser()).id;
    return NextResponse.json(await getAddressesForUser(userId));
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}

export async function POST(request: Request) {
  try {
    const userId = (await requireUser()).id;
    const body = await request.json().catch(() => null);
    const address = await createAddressForUser(userId, body);
    return NextResponse.json(address, { status: 201 });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: errorMessage(error) }, { status: errorStatus(error) });
  }
}
