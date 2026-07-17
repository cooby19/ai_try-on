import { NextResponse } from "next/server";
import { verifyInternalSecret } from "@/lib/notifications";
import { runRetentionBatch } from "@/lib/retention";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!verifyInternalSecret(request.headers.get("authorization"))) return NextResponse.json({ status: "failed", message: "Unauthorized" }, { status: 401 });
  try { return NextResponse.json({ status: "success", ...(await runRetentionBatch()) }); }
  catch (error) { return NextResponse.json({ status: "failed", message: error instanceof Error ? error.message : "資料保留工作失敗" }, { status: 500 }); }
}

export async function POST(request: Request) { return GET(request); }
