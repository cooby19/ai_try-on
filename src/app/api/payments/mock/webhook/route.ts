import { NextResponse } from "next/server";
import { errorMessage, errorStatus } from "@/lib/http";
import {
  MOCK_PAYMENT_SIGNATURE_HEADER,
  processMockPaymentWebhook,
} from "@/lib/mock-payments";

export async function POST(request: Request) {
  try {
    const rawBody = await request.text();
    const result = await processMockPaymentWebhook(
      rawBody,
      request.headers.get(MOCK_PAYMENT_SIGNATURE_HEADER)
    );
    return NextResponse.json({ status: "success", ...result });
  } catch (error) {
    return NextResponse.json(
      { status: "failed", message: errorMessage(error) },
      { status: errorStatus(error) }
    );
  }
}
