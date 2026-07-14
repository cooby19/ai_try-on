"use client";

import { useState } from "react";
import type { AccountDeletionRequestView } from "@/lib/types";

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Taipei",
});

export default function AccountDeletionPanel({
  initialRequest,
}: {
  initialRequest: AccountDeletionRequestView | null;
}) {
  const [request, setRequest] = useState(initialRequest);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submitRequest() {
    if (busy || request) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/account/deletion-request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() || null }),
      });
      const body = (await response.json().catch(() => null)) as
        | { message?: string; request?: AccountDeletionRequestView }
        | null;
      if (!response.ok || !body?.request) {
        setError(body?.message ?? "申請送出失敗，請稍後再試。");
        return;
      }
      setRequest(body.request);
      setConfirming(false);
    } catch {
      setError("網路連線異常，申請送出失敗。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-2xl border border-red-200 bg-red-50/40 p-6" aria-labelledby="danger-heading">
      <p className="text-xs font-medium uppercase tracking-widest text-red-500">危險操作</p>
      <h2 id="danger-heading" className="mt-1 text-xl font-semibold text-stone-900">申請刪除帳戶</h2>

      {request ? (
        <div className="mt-5 rounded-xl border border-green-200 bg-white p-4 text-sm leading-6">
          <p className="font-medium text-green-800">已收到你的帳戶刪除申請</p>
          <p className="mt-1 text-stone-600">
            申請時間：{formatDate(request.requestedAt)}。目前狀態為待處理，送出申請不代表資料已立即刪除。
          </p>
          <button type="button" disabled className="mt-4 rounded-lg bg-stone-200 px-4 py-2 text-sm text-stone-500">
            申請已送出
          </button>
        </div>
      ) : confirming ? (
        <div className="mt-5 rounded-xl border border-red-200 bg-white p-4">
          <p className="text-sm font-medium text-red-700">再次確認：你要送出帳戶刪除申請嗎？</p>
          <p className="mt-1 text-sm leading-6 text-stone-600">
            這一步只建立待處理申請，不會立刻刪除 Supabase Auth 使用者、照片或資料庫紀錄。
          </p>
          <label htmlFor="deletion-reason" className="mt-4 block text-sm font-medium text-stone-700">
            原因（選填）
          </label>
          <textarea
            id="deletion-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            maxLength={1000}
            rows={3}
            className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100"
            placeholder="可提供原因，協助我們處理申請"
          />
          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={submitRequest}
              disabled={busy}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? "送出中…" : "確認送出申請"}
            </button>
            <button
              type="button"
              onClick={() => { setConfirming(false); setError(null); }}
              disabled={busy}
              className="rounded-lg border border-stone-300 px-4 py-2 text-sm hover:bg-stone-50 disabled:opacity-50"
            >
              取消
            </button>
          </div>
          {error && <p className="mt-3 text-sm text-red-700" role="alert">{error}</p>}
        </div>
      ) : (
        <div className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-2xl text-sm leading-6 text-stone-600">
            送出後會建立待處理申請，供後續審核與處理。本版不會在按下按鈕時直接刪除帳戶或資料。
          </p>
          <button
            type="button"
            onClick={() => setConfirming(true)}
            className="shrink-0 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-50"
          >
            申請刪除帳戶
          </button>
        </div>
      )}
    </section>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "時間不明" : DATE_FORMATTER.format(date);
}
