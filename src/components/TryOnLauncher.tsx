"use client";
// AI 試穿流程（規格書第十節 TryOnModal）：
// 上傳照片（含規範提示）→ 預覽 → 開始試穿 → 輪詢生成狀態 → 顯示結果與回饋。
// 前端只呼叫自家後端 API，完全接觸不到 AI API key。
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { Product, ProductVariant, TryOnJobView, TryOnModel } from "@/lib/types";
import { validateFileMeta } from "@/lib/upload-constraints";
import { uploadFileToSignedUrl } from "@/lib/direct-upload";
import TryOnResult from "./TryOnResult";

const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 120_000; // 真實 VTO API 約 10~40 秒，保留餘裕

type Step = "upload" | "ready" | "generating" | "done";

interface Quota {
  remainingToday: number;
  remainingRetriesForProduct: number;
  dailyLimit: number;
  // 目前環境的預設生成模型；null 代表後端不開放選模型（mock 模式），前端隱藏選擇器
  defaultModel: TryOnModel | null;
}

export default function TryOnLauncher({
  product,
  variants,
  isAuthenticated,
}: {
  product: Product;
  variants: ProductVariant[];
  isAuthenticated: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>("upload");
  const [uploading, setUploading] = useState(false);
  const [personPath, setPersonPath] = useState<string | null>(null);
  const [personPreview, setPersonPreview] = useState<string | null>(null);
  const [job, setJob] = useState<TryOnJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [quota, setQuota] = useState<Quota | null>(null);
  const [model, setModel] = useState<TryOnModel | null>(null);
  const pollAbort = useRef<{ stop: boolean }>({ stop: false });
  const lastImageRefreshAt = useRef(0);
  // 只有 transport-level 不確定結果才沿用；收到任何 HTTP 回應後即結束這次生成意圖。
  const generationIntentKey = useRef<string | null>(null);

  const refreshQuota = useCallback(async () => {
    try {
      const res = await fetch(`/api/quota?productId=${product.id}`);
      if (res.ok) {
        const data: Quota = await res.json();
        setQuota(data);
        // 首次載入以環境預設模型初始化選擇器；之後刷新額度不覆蓋使用者的選擇
        setModel((current) => current ?? data.defaultModel);
      }
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
    const metaCheck = validateFileMeta({ type: file.type, size: file.size });
    if (!metaCheck.ok) {
      setError(metaCheck.message);
      return;
    }
    setUploading(true);
    try {
      // 1. Vercel 只接收 metadata JSON，回傳綁定隨機 path 的 Supabase signed upload URL。
      const prepareRes = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "prepare", mimeType: file.type, size: file.size }),
      });
      const prepared = await prepareRes.json();
      if (!prepareRes.ok) {
        setError(prepared.message ?? "建立照片上傳授權失敗，請再試一次。");
        return;
      }

      // 2. 原始大圖由瀏覽器直接送到 Supabase，不經過 Vercel Function request body。
      await uploadFileToSignedUrl(prepared.signedUrl, file);

      // 3. Vercel 只接收 path + 短效完成憑證，再從 Storage 驗證、縮圖並存成正式 JPEG。
      const completeRes = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "complete",
          path: prepared.path,
          completionToken: prepared.completionToken,
        }),
      });
      const completed = await completeRes.json();
      if (!completeRes.ok) {
        setError(completed.message ?? "照片驗證失敗，請重新選擇照片。");
        return;
      }
      setPersonPath(completed.path);
      setPersonPreview(completed.previewUrl);
      generationIntentKey.current = null;
      setStep("ready");
    } catch (e) {
      setError(e instanceof Error ? e.message : "網路連線異常，請確認網路後再試一次。");
    } finally {
      setUploading(false);
    }
  }

  async function refreshPersonPreview() {
    if (!personPath || Date.now() - lastImageRefreshAt.current < 5000) return;
    lastImageRefreshAt.current = Date.now();
    try {
      const res = await fetch(`/api/upload?path=${encodeURIComponent(personPath)}`);
      const data = await res.json();
      if (res.ok && data.signedUrl) setPersonPreview(data.signedUrl);
    } catch {
      /* signed URL 刷新失敗時保留原畫面，避免 onError 無限重試 */
    }
  }

  async function refreshJobImages() {
    if (!job || Date.now() - lastImageRefreshAt.current < 5000) return;
    lastImageRefreshAt.current = Date.now();
    try {
      const res = await fetch(`/api/try-on/${job.jobId}`);
      const data = (await res.json()) as TryOnJobView;
      if (res.ok) setJob(data);
    } catch {
      /* 同上：圖片刷新是非阻塞 fallback */
    }
  }

  async function handleGenerate() {
    if (!personPath) return;
    setError(null);
    setStep("generating");
    setJob(null);
    const idempotencyKey = generationIntentKey.current ?? crypto.randomUUID();
    generationIntentKey.current = idempotencyKey;
    try {
      const res = await fetch("/api/try-on", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        // model 只在可選模型的環境才會有值；未選（mock 模式）不帶欄位，後端沿用環境預設
        body: JSON.stringify({
          productId: product.id,
          personImagePath: personPath,
          ...(model ? { model } : {}),
        }),
      });
      const data = await res.json();
      generationIntentKey.current = null;
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

  // 重新生成專用：結果頁按鈕會進到這裡，先二次確認再生成。
  // 「建立 job = 額度 +1」，一點就扣一格今日額度，結果頁按鈕又密集，
  // 因此比照 deleteRecord 的原生 confirm 慣例加一道確認，避免誤點白扣額度。
  // 刻意只包在重新生成：第一次生成的「開始 AI 試穿」已是使用者刻意動作，不再攔。
  function handleRegenerate() {
    // quota 尚未載入（fetch 失敗）時退用不帶數字的簡短文案，避免顯示 undefined
    const message = quota
      ? `重新生成會使用一次今日額度（今日還剩 ${quota.remainingToday} 次、此商品還可生成 ${quota.remainingRetriesForProduct} 次），確定要繼續嗎？`
      : "重新生成會使用一次今日額度，確定要繼續嗎？";
    if (!confirm(message)) return;
    handleGenerate();
  }

  function resetToUpload() {
    setStep("upload");
    setPersonPath(null);
    setPersonPreview(null);
    setJob(null);
    setError(null);
  }

  if (!isAuthenticated) {
    return (
      <Link
        href={`/login?returnTo=${encodeURIComponent(`/products/${product.id}`)}`}
        className="rounded-lg bg-stone-900 px-5 py-2.5 text-center text-sm font-medium text-white hover:bg-stone-700 transition-colors"
      >
        AI 試穿
      </Link>
    );
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
                      onError={refreshPersonPreview}
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
                {quota?.defaultModel && model && (
                  <div className="mt-4">
                    <ModelSelector value={model} onChange={setModel} />
                  </div>
                )}
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
                variants={variants}
                personPreview={job.personImageUrl ?? personPreview}
                canRegenerate={
                  (quota?.remainingToday ?? 0) > 0 && (quota?.remainingRetriesForProduct ?? 0) > 0
                }
                onRegenerate={handleRegenerate}
                onChangePhoto={resetToUpload}
                onDeleted={resetToUpload}
                onImageError={refreshJobImages}
                // 結果頁也放選擇器：重新生成沿用上次選擇，但允許先改選再按「重新生成」
                modelSelector={
                  quota?.defaultModel && model ? (
                    <ModelSelector value={model} onChange={setModel} />
                  ) : undefined
                }
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}

// 生成模型選擇器：只在後端回報可選模型（quota.defaultModel 非 null）時顯示。
// 文案只講速度與品質差異，不透出內部成本數字——成本記在 job.cost_estimate 供後台統計。
function ModelSelector({
  value,
  onChange,
}: {
  value: TryOnModel;
  onChange: (model: TryOnModel) => void;
}) {
  const options: { key: TryOnModel; label: string; hint: string }[] = [
    { key: "v1.6", label: "標準", hint: "速度較快，日常預覽適用" },
    { key: "max", label: "高品質", hint: "細節更好，生成時間較長" },
  ];
  return (
    <fieldset>
      <legend className="mb-1.5 text-xs text-stone-500">生成品質</legend>
      <div className="grid grid-cols-2 gap-2">
        {options.map((opt) => (
          <label
            key={opt.key}
            className={`cursor-pointer rounded-lg border px-3 py-2 transition-colors ${
              value === opt.key
                ? "border-stone-800 bg-stone-50"
                : "border-stone-200 hover:border-stone-400"
            }`}
          >
            <input
              type="radio"
              name="tryon-model"
              value={opt.key}
              checked={value === opt.key}
              onChange={() => onChange(opt.key)}
              className="sr-only"
            />
            <span className="block text-sm font-medium">{opt.label}</span>
            <span className="mt-0.5 block text-xs text-stone-500">{opt.hint}</span>
          </label>
        ))}
      </div>
    </fieldset>
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
          <li>支援 JPG / PNG / WebP，圖片不得超過 8MB（建議寬度 1080～1440px）</li>
        </ul>
        <p className="mt-3 text-xs text-stone-500">
          拍攝建議：明亮均勻的光線、正面站姿、雙手自然放下、背景乾淨、身上穿著合身上衣。
        </p>
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
