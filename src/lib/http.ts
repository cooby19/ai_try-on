// API route 共用的小工具
import { NextResponse } from "next/server";

export class AppError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "AppError";
  }
}

export function jsonError(status: number, message: string, extra?: Record<string, unknown>) {
  return NextResponse.json({ status: "failed", message, ...extra }, { status });
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : "發生未知錯誤";
}

export function errorStatus(e: unknown): number {
  return e instanceof AppError ? e.status : 500;
}
