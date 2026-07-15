"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { validateRecipientInput } from "@/lib/checkout-validation";
import type { AddressBookEntry, ShippingMethod } from "@/lib/types";
import { useCart } from "./CartProvider";

const currency = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  maximumFractionDigits: 0,
});

type RecipientForm = {
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
};

const EMPTY_FORM: RecipientForm = {
  recipientName: "",
  recipientPhone: "",
  recipientAddress: "",
};

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body = (await response.json().catch(() => null)) as T & { message?: string };
  if (!response.ok) throw new Error(body?.message ?? "資料載入失敗，請稍後再試。" );
  return body;
}

export default function CheckoutPageClient() {
  const router = useRouter();
  const { cart, loading: cartLoading, refresh } = useCart();
  const [addresses, setAddresses] = useState<AddressBookEntry[]>([]);
  const [shippingMethods, setShippingMethods] = useState<ShippingMethod[]>([]);
  const [form, setForm] = useState<RecipientForm>(EMPTY_FORM);
  const [selectedAddressId, setSelectedAddressId] = useState<string | null>(null);
  const [shippingMethodCode, setShippingMethodCode] = useState("");
  const [loadingOptions, setLoadingOptions] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadingOptions(true);
      setLoadError(null);
      try {
        const [nextAddresses, nextMethods] = await Promise.all([
          getJson<AddressBookEntry[]>("/api/addresses"),
          getJson<ShippingMethod[]>("/api/shipping-methods"),
        ]);
        if (cancelled) return;
        setAddresses(nextAddresses);
        setShippingMethods(nextMethods);
        if (nextMethods.length === 1) setShippingMethodCode(nextMethods[0].code);
      } catch (error) {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "結帳資料載入失敗。" );
      } finally {
        if (!cancelled) setLoadingOptions(false);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  function chooseAddress(address: AddressBookEntry) {
    setSelectedAddressId(address.id);
    setForm({
      recipientName: address.recipientName,
      recipientPhone: address.recipientPhone,
      recipientAddress: address.recipientAddress,
    });
  }

  function updateField(field: keyof RecipientForm, value: string) {
    setSelectedAddressId(null);
    setForm((previous) => ({ ...previous, [field]: value }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recipient = validateRecipientInput(form);
    if (!recipient.ok) {
      setSubmitError(recipient.message);
      return;
    }
    if (!shippingMethodCode) {
      setSubmitError("請選擇運送方式。" );
      return;
    }
    if (cart.items.length === 0) {
      setSubmitError("購物車是空的，無法建立訂單。" );
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...recipient.value,
          shippingMethodCode,
          idempotencyKey: idempotencyKey.current,
        }),
      });
      const body = (await response.json().catch(() => null)) as { orderId?: string; message?: string } | null;
      if (!response.ok || !body?.orderId) throw new Error(body?.message ?? "訂單建立失敗，請稍後再試。" );
      await refresh();
      router.replace(`/orders/${body.orderId}`);
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : "訂單建立失敗，請稍後再試。" );
    } finally {
      setSubmitting(false);
    }
  }

  const selectedShipping = shippingMethods.find((method) => method.code === shippingMethodCode);
  const total = cart.subtotal + (selectedShipping?.fee ?? 0);

  if (cartLoading || loadingOptions) {
    return <p className="py-16 text-center text-sm text-stone-500">正在準備結帳資料…</p>;
  }

  if (loadError) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-red-200 bg-red-50 p-5 text-sm text-red-700">
        <p>{loadError}</p>
        <button type="button" onClick={() => window.location.reload()} className="mt-3 underline">重新載入</button>
      </div>
    );
  }

  if (!cart.items.length) {
    return (
      <div className="mx-auto max-w-xl rounded-xl border border-stone-200 bg-white px-6 py-16 text-center">
        <h1 className="text-xl font-semibold">購物車目前是空的</h1>
        <p className="mt-2 text-sm text-stone-500">請先選擇商品後再結帳。</p>
        <Link href="/cart" className="mt-5 inline-block rounded-lg bg-stone-900 px-5 py-2.5 text-sm font-medium text-white hover:bg-stone-700">返回購物車</Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="mx-auto max-w-5xl">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">結帳</h1>
          <p className="mt-1 text-sm text-stone-500">確認收件資訊與運送方式後，將建立待付款訂單。</p>
        </div>
        <Link href="/cart" className="text-sm text-stone-500 hover:underline">返回購物車</Link>
      </div>

      {submitError && <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{submitError}</div>}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="space-y-6">
          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-semibold">地址簿</h2>
              <Link href="/account/addresses" className="text-sm text-stone-500 hover:underline">管理地址簿</Link>
            </div>
            {addresses.length ? (
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {addresses.map((address) => (
                  <button
                    key={address.id}
                    type="button"
                    onClick={() => chooseAddress(address)}
                    className={`rounded-lg border p-3 text-left text-sm transition ${selectedAddressId === address.id ? "border-stone-900 bg-stone-50 ring-1 ring-stone-900" : "border-stone-200 hover:border-stone-400"}`}
                  >
                    <span className="font-medium">{address.label}</span>
                    <span className="mt-1 block">{address.recipientName} · {address.recipientPhone}</span>
                    <span className="mt-1 block text-stone-500">{address.recipientAddress}</span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-stone-500">尚無常用地址；可直接填寫本次收件資料，或先前往地址簿新增。</p>
            )}
          </section>

          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="font-semibold">收件人資料</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="收件人姓名" id="recipientName" value={form.recipientName} onChange={(value) => updateField("recipientName", value)} autoComplete="name" />
              <Field label="手機號碼" id="recipientPhone" value={form.recipientPhone} onChange={(value) => updateField("recipientPhone", value)} autoComplete="tel" inputMode="tel" placeholder="0912345678" />
              <div className="sm:col-span-2">
                <label htmlFor="recipientAddress" className="block text-sm font-medium">完整收件地址</label>
                <textarea id="recipientAddress" required rows={3} value={form.recipientAddress} onChange={(event) => updateField("recipientAddress", event.target.value)} autoComplete="street-address" className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm outline-none focus:border-stone-600" placeholder="請填寫郵遞區號、縣市、區域、街道與門牌" />
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-stone-200 bg-white p-5">
            <h2 className="font-semibold">運送方式</h2>
            <div className="mt-4 space-y-3">
              {shippingMethods.map((method) => (
                <label key={method.code} className={`flex cursor-pointer items-center justify-between rounded-lg border p-4 text-sm ${shippingMethodCode === method.code ? "border-stone-900 bg-stone-50" : "border-stone-200"}`}>
                  <span className="flex items-center gap-3"><input type="radio" name="shippingMethod" value={method.code} checked={shippingMethodCode === method.code} onChange={() => setShippingMethodCode(method.code)} />{method.name}</span>
                  <span className="font-medium">{currency.format(method.fee)}</span>
                </label>
              ))}
              {!shippingMethods.length && <p className="text-sm text-red-600">目前沒有可用運送方式，請稍後再試。</p>}
            </div>
          </section>
        </div>

        <aside className="h-fit rounded-xl border border-stone-200 bg-white p-5 lg:sticky lg:top-5">
          <h2 className="font-semibold">訂單摘要</h2>
          <ul className="mt-4 space-y-3 text-sm">
            {cart.items.map((item) => <li key={item.variantId} className="flex justify-between gap-3"><span className="min-w-0"><span className="block truncate">{item.name}</span><span className="text-stone-500">{item.size} × {item.quantity}</span></span><span className="shrink-0">{currency.format(item.lineSubtotal)}</span></li>)}
          </ul>
          <div className="mt-4 space-y-2 border-t border-stone-200 pt-4 text-sm">
            <div className="flex justify-between"><span className="text-stone-500">商品小計</span><span>{currency.format(cart.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-stone-500">運費</span><span>{selectedShipping ? currency.format(selectedShipping.fee) : "請選擇"}</span></div>
            <div className="flex justify-between border-t border-stone-200 pt-3 text-base font-semibold"><span>應付總額</span><span>{currency.format(total)}</span></div>
          </div>
          <button type="submit" disabled={submitting || !shippingMethods.length} className="mt-5 w-full rounded-lg bg-stone-900 px-4 py-3 text-sm font-medium text-white hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-50">{submitting ? "建立訂單中…" : "確認建立待付款訂單"}</button>
          <p className="mt-3 text-xs leading-5 text-stone-500">送出後將以伺服器的最新價格與庫存建立訂單；本版本尚未串接付款。</p>
        </aside>
      </div>
    </form>
  );
}

function Field({ label, id, value, onChange, autoComplete, inputMode, placeholder }: { label: string; id: string; value: string; onChange: (value: string) => void; autoComplete: string; inputMode?: "text" | "tel"; placeholder?: string }) {
  return <div><label htmlFor={id} className="block text-sm font-medium">{label}</label><input id={id} required type="text" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} inputMode={inputMode} placeholder={placeholder} className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm outline-none focus:border-stone-600" /></div>;
}
