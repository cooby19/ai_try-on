"use client";
// AI 試穿流程（規格書第十節 TryOnModal）：
// 上傳照片（含規範提示）→ 預覽 → 開始試穿 → 輪詢生成狀態 → 顯示結果與回饋。
// 前端只呼叫自家後端 API，完全接觸不到 AI API key。
import { useCallback, useEffect, useRef, useState } from "react";
import type { Product, TryOnJobView } from "@/lib/types";
import TryOnResult from "./TryOnResult";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000; // 真實 VTO API 約 10~40 秒，保留餘裕

type Step = "upload" | "ready" | "generating" | "done";

interface Quota {
  remainingToday: number;
  remainingRetriesForProduct: number;
  dailyLimit: number;
}

export default function TryOnLauncher({ product }: { product: Product }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  const [uploading, setUploading] = useState(false);
  const [personPath, setPersonPath] = useState<string | null>(null);
  const [personPreview, setPersonPreview] = useState<string | null>(null);
  const [job, setJob] = useState<TryOnJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const pollAbort = useRef<{ stop: boolean }>({ stop: false });

  const refreshQuota = useCallback(async () => {
    try {
      const res = await fetch(`/api/quota?productId=${product.id}`);
      if (res.ok) setQuota(await res.json());
    } catch {
      /* 額度顯示失敗不擋流程 */
    }
  }, [product.id]);

  useEffect(() => {
    // refreshQuota 是 async：setQuota 發生在 await fetch 之後，並非同步 setState，
    // 不會造成串聯渲染；「開啟 modal 時向後端同步額度」正是 effect 的正當用途。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (open) refreshQuota();
  }, [open, refreshQuota]);

  // 關閉 modal 時停止輪詢
  useEffect(() => {
    const ref = pollAbort.current;
    return () => {
      ref.stop = true;
    };
  }, []);

  async function handleUpload(file: File) {
    setError(null);
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch("/api/upload", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "照片上傳失敗，請再試一次。");
        return;
      }
      setPersonPath(data.path);
      setPersonPreview(data.previewUrl);
      setStep("ready");
    } catch {
      setError("網路連線異常，請確認網路後再試一次。");
    } finally {
      setUploading(false);
    }
  }

  async function handleGenerate() {
    if (!personPath) return;
    setError(null);
    setStep("generating");
    setJob(null);
    try {
      const res = await fetch("/api/try-on", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productId: product.id, personImagePath: personPath }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.message ?? "AI 試穿啟動失敗，請再試一次。");
        setStep("ready");
        refreshQuota();
        return;
      }
      await pollJob(data.jobId);
    } catch {
      setError("網路連線異常，請確認網路後再試一次。");
      setStep("ready");
    }
  }

  async function pollJob(jobId: string) {
    pollAbort.current = { stop: false };
    const abort = pollAbort.current;
    const startedAt = Date.now();

    while (!abort.stop && Date.now() - startedAt < POLL_TIMEOUT_MS) {
      try {
        const res = await fetch(`/api/try-on/${jobId}`);
        const data: TryOnJobView & { message?: string } = await res.json();
        if (!res.ok) {
          setError(data.message ?? "查詢生成進度失敗，請重新生成一次。");
          setStep("ready");
          refreshQuota();
          return;
        }
        if (data.status === "success") {
          setJob(data);
          setStep("done");
          refreshQuota();
          return;
        }
        if (data.status === "failed") {
          setError(data.message ?? "AI 生成失敗，請換一張正面半身、上衣清楚的照片再試。");
          setStep("ready");
          refreshQuota();
          return;
        }
      } catch {
        // 單次輪詢失敗不中斷，等下一輪
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    if (!abort.stop) {
      setError("生成時間比預期久，請稍後重新生成一次。這次若有扣額度，失敗紀錄可在後台查到。");
      setStep("ready");
      refreshQuota();
    }
  }

  function resetToUpload() {
    setStep("upload");
    setPersonPath(null);
    setPersonPreview(null);
    setJob(null);
    setError(null);
  }

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 transition-colors"
      >
        AI 試穿
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-2xl bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h2 className="text-lg font-semibold">AI 試穿 — {product.name}</h2>
                {quota && (
                  <p className="text-xs text-stone-500 mt-0.5">
                    今日剩餘 {quota.remainingToday}/{quota.dailyLimit} 次 · 此商品還可生成{" "}
                    {quota.remainingRetriesForProduct} 次
                  </p>
                )}
              </div>
              <button
                onClick={() => {
                  pollAbort.current.stop = true;
                  setOpen(false);
                }}
                aria-label="關閉"
                className="text-stone-400 hover:text-stone-600 text-xl leading-none"
              >
                ×
              </button>
            </div>

            {error && (
              <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                {error}
              </div>
            )}

            {step === "upload" && (
              <UploadStep uploading={uploading} onSelect={handleUpload} />
            )}

            {step === "ready" && personPreview && (
              <div>
                <div className="grid grid-cols-2 gap-4">
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={personPreview}
                      alt="你的照片"
                      className="w-full rounded-lg border border-stone-200 object-cover"
                    />
                    <figcaption className="mt-1 text-xs text-stone-500 text-center">你的照片</figcaption>
                  </figure>
                  <figure>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={product.garment_image_url}
                      alt={product.name}
                      className="w-full rounded-lg border border-stone-200 object-cover bg-stone-50"
                    />
                    <figcaption className="mt-1 text-xs text-stone-500 text-center">要試穿的上衣</figcaption>
                  </figure>
                </div>
                <div className="mt-5 flex gap-3">
                  <button
                    onClick={handleGenerate}
                    disabled={quota?.remainingToday === 0 || quota?.remainingRetriesForProduct === 0}
                    className="flex-1 rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    開始 AI 試穿
                  </button>
                  <button
                    onClick={resetToUpload}
                    className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm hover:bg-stone-50"
                  >
                    換一張照片
                  </button>
                </div>
              </div>
            )}

            {step === "generating" && (
              <div className="py-16 text-center">
                <div className="mx-auto mb-4 h-10 w-10 animate-spin rounded-full border-4 border-stone-200 border-t-stone-800" />
                <p className="text-sm font-medium">AI 正在為你換上這件上衣…</p>
                <p className="mt-1 text-xs text-stone-500">通常需要 10～40 秒，請不要關閉視窗</p>
              </div>
            )}

            {step === "done" && job && personPreview && (
              <TryOnResult
                job={job}
                product={product}
                personPreview={job.personImageUrl ?? personPreview}
                canRegenerate={
                  (quota?.remainingToday ?? 0) > 0 && (quota?.remainingRetriesForProduct ?? 0) > 0
                }
                onRegenerate={handleGenerate}
                onDeleted={resetToUpload}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

// 上傳步驟：規範提示 + 檔案選擇（規格書第三、八節的文案）
function UploadStep({
  uploading,
  onSelect,
}: {
  uploading: boolean;
  onSelect: (file: File) => void;
}) {
  return (
    <div>
      <div className="rounded-lg bg-stone-50 border border-stone-200 p-4 text-sm">
        <p className="font-medium mb-2">照片規範（照著拍，效果最好）</p>
        <ul className="list-disc pl-5 space-y-1 text-stone-600">
          <li>單人照片，不要多人合照</li>
          <li>正面或接近正面的半身照</li>
          <li>上衣區域清楚可見，手自然放下、不要抱胸</li>
          <li>避免包包、手機擋住身體</li>
          <li>光線充足、不要太暗或太模糊</li>
          <li>支援 JPG / PNG / WebP，8MB 以內（建議寬度 768～1024px）</li>
        </ul>
      </div>
      <label className="mt-4 block">
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={uploading}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onSelect(file);
            e.target.value = ""; // 允許重選同一個檔案
          }}
          className="hidden"
        />
        <span className="flex cursor-pointer items-center justify-center rounded-lg border-2 border-dashed border-stone-300 px-6 py-10 text-sm text-stone-500 hover:border-stone-400 hover:text-stone-700 transition-colors">
          {uploading ? "照片處理中…" : "點擊選擇一張人物照片"}
        </span>
      </label>
    </div>
  );
}
