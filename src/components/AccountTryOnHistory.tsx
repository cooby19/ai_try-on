"use client";

import Link from "next/link";
import { useState } from "react";
import type { AccountTryOnItem, JobStatus } from "@/lib/types";

const STATUS_LABELS: Record<JobStatus, string> = {
  pending: "等待處理",
  processing: "生成中",
  success: "已完成",
  failed: "未完成",
};

const DATE_FORMATTER = new Intl.DateTimeFormat("zh-TW", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Taipei",
});

export default function AccountTryOnHistory({ initialItems }: { initialItems: AccountTryOnItem[] }) {
  const [items, setItems] = useState(initialItems);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ jobId: string; message: string } | null>(null);

  async function deletePhotos(item: AccountTryOnItem) {
    if (deletingId) return;
    if (!window.confirm("確定要刪除這次試穿的人物照與結果照嗎？照片刪除後無法復原，試穿與額度紀錄仍會保留。")) {
      return;
    }

    setDeletingId(item.jobId);
    setNotice(null);
    try {
      const response = await fetch(`/api/try-on/${item.jobId}`, { method: "DELETE" });
      const body = (await response.json().catch(() => null)) as
        | { message?: string; jobStatus?: JobStatus }
        | null;
      if (!response.ok) {
        setNotice({ jobId: item.jobId, message: body?.message ?? "照片刪除失敗，請稍後再試。" });
        return;
      }
      setItems((current) =>
        current.map((currentItem) =>
          currentItem.jobId === item.jobId
            ? {
                ...currentItem,
                photosDeleted: true,
                resultImageUrl: null,
                status: body?.jobStatus ?? currentItem.status,
              }
            : currentItem
        )
      );
      setNotice({ jobId: item.jobId, message: body?.message ?? "照片已刪除。" });
    } catch {
      setNotice({ jobId: item.jobId, message: "網路連線異常，照片刪除失敗。" });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <section className="rounded-2xl border border-stone-200 bg-white p-6" aria-labelledby="try-on-heading">
      <div>
        <p className="text-xs font-medium uppercase tracking-widest text-stone-400">我的試穿</p>
        <h2 id="try-on-heading" className="mt-1 text-xl font-semibold">全部試穿紀錄</h2>
        <p className="mt-1 text-sm text-stone-500">共 {items.length} 筆，依建立時間由新到舊排列。</p>
      </div>

      {items.length === 0 ? (
        <div className="mt-6 rounded-xl border border-dashed border-stone-300 px-5 py-10 text-center">
          <p className="text-sm text-stone-500">你還沒有試穿紀錄。</p>
          <Link href="/" className="mt-3 inline-block text-sm font-medium text-stone-800 underline underline-offset-4">
            前往挑選商品
          </Link>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-stone-100 border-y border-stone-100">
          {items.map((item) => (
            <li key={item.jobId} className="grid gap-4 py-5 sm:grid-cols-[6rem_1fr_auto] sm:items-center">
              <PhotoPreview item={item} />
              <div className="min-w-0">
                <Link href={`/products/${item.productId}`} className="font-medium text-stone-900 hover:underline">
                  {item.productName}
                </Link>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
                  <time dateTime={item.createdAt}>{formatDate(item.createdAt)}</time>
                  <span className="rounded-full bg-stone-100 px-2 py-0.5 font-medium text-stone-600">
                    {STATUS_LABELS[item.status]}
                  </span>
                </div>
                {notice?.jobId === item.jobId && (
                  <p className="mt-2 text-xs leading-5 text-stone-500" role="status">{notice.message}</p>
                )}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {item.resultImageUrl && !item.photosDeleted ? (
                  <a
                    href={item.resultImageUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="rounded-lg border border-stone-300 px-3 py-2 text-sm hover:bg-stone-50"
                  >
                    查看結果
                  </a>
                ) : (
                  <span className="cursor-not-allowed rounded-lg border border-stone-200 px-3 py-2 text-sm text-stone-300">
                    查看結果
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => deletePhotos(item)}
                  disabled={item.photosDeleted || deletingId !== null}
                  className="rounded-lg px-3 py-2 text-sm text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:text-stone-300 disabled:hover:bg-transparent"
                >
                  {deletingId === item.jobId ? "刪除中…" : item.photosDeleted ? "照片已刪除" : "刪除照片"}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function PhotoPreview({ item }: { item: AccountTryOnItem }) {
  if (item.photosDeleted) {
    return (
      <div className="flex aspect-square w-24 items-center justify-center rounded-xl border border-dashed border-stone-300 bg-stone-50 px-2 text-center text-xs leading-5 text-stone-500">
        照片已刪除
      </div>
    );
  }
  if (!item.resultImageUrl) {
    return (
      <div className="flex aspect-square w-24 items-center justify-center rounded-xl bg-stone-100 px-2 text-center text-xs leading-5 text-stone-400">
        尚無結果圖
      </div>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={item.resultImageUrl}
      alt={`${item.productName} 試穿結果`}
      className="aspect-square w-24 rounded-xl border border-stone-200 bg-stone-100 object-cover"
    />
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "時間不明" : DATE_FORMATTER.format(date);
}
