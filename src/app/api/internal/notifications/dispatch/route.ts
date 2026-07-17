import { NextResponse } from "next/server";
import { dispatchNotifications, verifyInternalSecret } from "@/lib/notifications";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  if (!verifyInternalSecret(request.headers.get("authorization"))) {
    return NextResponse.json({ status: "failed", message: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ status: "success", ...(await dispatchNotifications(20)) });
  } catch (error) {
    return NextResponse.json({ status: "failed", message: error instanceof Error ? error.message : "通知派送失敗" }, { status: 500 });
  }
}

export async function GET(request: Request) {
  return POST(request);
}
