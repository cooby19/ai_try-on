"use client";
// 試穿結果（規格書第十、十一節）：原圖 / 結果對比、免責文案、
// 滿意 / 不滿意回饋、重新生成、加入購物車、刪除紀錄（隱私）。
import { useState, type ReactNode } from "react";
import type { Product, TryOnJobView, FeedbackRating } from "@/lib/types";
import AddToCartButton from "./AddToCartButton";

export default function TryOnResult({
  job,
  product,
  personPreview,
  canRegenerate,
  onRegenerate,
  onDeleted,
  modelSelector,
}: {
  job: TryOnJobView;
  product: Product;
  personPreview: string;
  canRegenerate: boolean;
  onRegenerate: () => void;
  onDeleted: () => void;
  // 生成模型選擇器（選填）：狀態由 TryOnLauncher 持有，這裡只負責擺在「重新生成」附近，
  // 讓使用者重按前可以改選模型；mock 模式不會傳入
  modelSelector?: ReactNode;
}) {
  const [feedback, setFeedback] = useState<FeedbackRating | null>(null);
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function sendFeedback(rating: FeedbackRating) {
    if (feedback || feedbackBusy) return;
    setFeedbackBusy(true);
    try {
      const res = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: job.jobId, rating }),
      });
      if (res.ok) {
        setFeedback(rating);
        setNotice("已收到你的回饋，謝謝！");
      } else {
        const data = await res.json();
        setNotice(data.message ?? "回饋送出失敗，請再試一次。");
      }
    } catch {
      setNotice("網路異常，回饋送出失敗。");
    } finally {
      setFeedbackBusy(false);
    }
  }

  async function deleteRecord() {
    if (deleteBusy) return;
    if (!confirm("確定要刪除這次試穿的照片嗎？照片將立即刪除且無法復原（生成次數仍會計入今日額度）。")) return;
    setDeleteBusy(true);
    try {
      const res = await fetch(`/api/try-on/${job.jobId}`, { method: "DELETE" });
      if (res.ok) {
        onDeleted();
      } else {
        const data = await res.json();
        setNotice(data.message ?? "刪除失敗，請再試一次。");
      }
    } catch {
      setNotice("網路異常，刪除失敗。");
    } finally {
      setDeleteBusy(false);
    }
  }

  return (
    <div>
      {/* 原圖 / 結果 前後對比 */}
      <div className="grid grid-cols-2 gap-4">
        <figure>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={personPreview}
            alt="原始照片"
            className="w-full rounded-lg border border-stone-200 object-cover"
          />
          <figcaption className="mt-1 text-xs text-stone-500 text-center">原始照片</figcaption>
        </figure>
        <figure>
          {job.resultImageUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={job.resultImageUrl}
              alt="AI 試穿結果"
              className="w-full rounded-lg border-2 border-stone-800 object-cover"
            />
          )}
          <figcaption className="mt-1 text-xs font-medium text-center">AI 試穿結果</figcaption>
        </figure>
      </div>

      {/* 商品資訊 + 免責文案（規格書第十一節，逐字） */}
      <div className="mt-4 rounded-lg bg-stone-50 border border-stone-200 p-4">
        <p className="text-sm font-medium">
          {product.name} · NT$ {Math.round(product.price)}
        </p>
        <p className="text-xs text-stone-500 mt-0.5">
          {product.color} · {product.fit} · {product.material}
        </p>
        <p className="mt-3 text-xs leading-5 text-stone-500">
          AI 試穿圖為視覺預覽，主要用於參考顏色、風格與大致版型。實際穿著效果仍會因尺寸、布料、彈性、拍攝角度與個人身形而不同。
        </p>
      </div>

      {notice && <p className="mt-3 text-sm text-stone-600">{notice}</p>}

      {/* 滿意 / 不滿意 */}
      <div className="mt-4 flex items-center gap-3">
        <span className="text-sm text-stone-500">這個結果如何？</span>
        <button
          onClick={() => sendFeedback("satisfied")}
          disabled={feedbackBusy || feedback !== null}
          className={`rounded-lg border px-4 py-1.5 text-sm transition-colors disabled:cursor-not-allowed ${
            feedback === "satisfied"
              ? "border-green-600 bg-green-50 text-green-700"
              : "border-stone-300 hover:bg-stone-50 disabled:opacity-40"
          }`}
        >
          👍 滿意
        </button>
        <button
          onClick={() => sendFeedback("unsatisfied")}
          disabled={feedbackBusy || feedback !== null}
          className={`rounded-lg border px-4 py-1.5 text-sm transition-colors disabled:cursor-not-allowed ${
            feedback === "unsatisfied"
              ? "border-red-500 bg-red-50 text-red-600"
              : "border-stone-300 hover:bg-stone-50 disabled:opacity-40"
          }`}
        >
          👎 不滿意
        </button>
      </div>

      {/* 重新生成前可改選模型 */}
      {modelSelector && <div className="mt-4">{modelSelector}</div>}

      {/* 動作列 */}
      <div className="mt-5 flex flex-wrap gap-3">
        <AddToCartButton productName={product.name} />
        <button
          onClick={onRegenerate}
          disabled={!canRegenerate}
          title={canRegenerate ? undefined : "已達今日生成或此商品重試上限"}
          className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm hover:bg-stone-50 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          重新生成
        </button>
        <button
          onClick={deleteRecord}
          disabled={deleteBusy}
          className="ml-auto rounded-lg px-3 py-2.5 text-sm text-stone-400 hover:text-red-600 disabled:opacity-40"
        >
          {deleteBusy ? "刪除中…" : "刪除這次試穿的照片"}
        </button>
      </div>
    </div>
  );
}
