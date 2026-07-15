"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { validateSavedAddressInput } from "@/lib/checkout-validation";
import type { AddressBookEntry } from "@/lib/types";

type AddressForm = {
  label: string;
  recipientName: string;
  recipientPhone: string;
  recipientAddress: string;
};

const EMPTY_FORM: AddressForm = { label: "", recipientName: "", recipientPhone: "", recipientAddress: "" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: init?.body ? { "Content-Type": "application/json", ...init.headers } : init?.headers,
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as T & { message?: string };
  if (!response.ok) throw new Error(body?.message ?? "地址簿操作失敗，請稍後再試。" );
  return body;
}

function asForm(address: AddressBookEntry): AddressForm {
  return { label: address.label, recipientName: address.recipientName, recipientPhone: address.recipientPhone, recipientAddress: address.recipientAddress };
}

export default function AddressBookClient() {
  const [addresses, setAddresses] = useState<AddressBookEntry[]>([]);
  const [form, setForm] = useState<AddressForm>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void request<AddressBookEntry[]>("/api/addresses")
      .then((items) => {
        if (!cancelled) setAddresses(items);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "地址簿載入失敗。" );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const validation = validateSavedAddressInput(form);
    if (!validation.ok) {
      setError(validation.message);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingId) {
        const updated = await request<AddressBookEntry>(`/api/addresses/${editingId}`, { method: "PATCH", body: JSON.stringify(validation.value) });
        setAddresses((items) => items.map((item) => item.id === updated.id ? updated : item));
      } else {
        const created = await request<AddressBookEntry>("/api/addresses", { method: "POST", body: JSON.stringify(validation.value) });
        setAddresses((items) => [created, ...items]);
      }
      resetForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "地址儲存失敗。" );
    } finally {
      setBusy(false);
    }
  }

  async function remove(address: AddressBookEntry) {
    if (!window.confirm(`確定要刪除「${address.label}」嗎？`)) return;
    setBusy(true);
    setError(null);
    try {
      await request<void>(`/api/addresses/${address.id}`, { method: "DELETE" });
      setAddresses((items) => items.filter((item) => item.id !== address.id));
      if (editingId === address.id) resetForm();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "地址刪除失敗。" );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex items-end justify-between gap-4"><div><h1 className="text-2xl font-semibold">地址簿</h1><p className="mt-1 text-sm text-stone-500">管理常用收件資料，結帳時可快速帶入。</p></div><Link href="/account" className="text-sm text-stone-500 hover:underline">返回帳戶設定</Link></div>
      {error && <div role="alert" className="mt-5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      <section className="mt-6 rounded-xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">{editingId ? "編輯地址" : "新增常用地址"}</h2>
        <form onSubmit={submit} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Input label="地址名稱" id="label" value={form.label} onChange={(value) => setForm((previous) => ({ ...previous, label: value }))} placeholder="例如：住家、公司" />
          <Input label="收件人姓名" id="recipientName" value={form.recipientName} onChange={(value) => setForm((previous) => ({ ...previous, recipientName: value }))} autoComplete="name" />
          <Input label="手機號碼" id="recipientPhone" value={form.recipientPhone} onChange={(value) => setForm((previous) => ({ ...previous, recipientPhone: value }))} autoComplete="tel" placeholder="0912345678" />
          <div className="sm:col-span-2"><label htmlFor="recipientAddress" className="block text-sm font-medium">完整收件地址</label><textarea id="recipientAddress" required rows={3} value={form.recipientAddress} onChange={(event) => setForm((previous) => ({ ...previous, recipientAddress: event.target.value }))} autoComplete="street-address" className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm outline-none focus:border-stone-600" /></div>
          <div className="flex gap-3 sm:col-span-2"><button type="submit" disabled={busy} className="rounded-lg bg-stone-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-stone-700 disabled:opacity-50">{busy ? "儲存中…" : editingId ? "儲存變更" : "新增地址"}</button>{editingId && <button type="button" disabled={busy} onClick={resetForm} className="rounded-lg border border-stone-300 px-4 py-2.5 text-sm hover:bg-stone-50">取消編輯</button>}</div>
        </form>
      </section>

      <section className="mt-6"><h2 className="font-semibold">已儲存地址</h2>{loading ? <p className="mt-4 text-sm text-stone-500">正在載入地址簿…</p> : !addresses.length ? <p className="mt-4 rounded-xl border border-stone-200 bg-white px-5 py-8 text-sm text-stone-500">尚未儲存任何地址。</p> : <div className="mt-4 space-y-3">{addresses.map((address) => <article key={address.id} className="rounded-xl border border-stone-200 bg-white p-4"><div className="flex items-start justify-between gap-4"><div><h3 className="font-medium">{address.label}</h3><p className="mt-1 text-sm">{address.recipientName} · {address.recipientPhone}</p><p className="mt-1 text-sm text-stone-500">{address.recipientAddress}</p></div><div className="flex shrink-0 gap-3 text-sm"><button type="button" disabled={busy} onClick={() => { setEditingId(address.id); setForm(asForm(address)); setError(null); }} className="text-stone-600 hover:underline">編輯</button><button type="button" disabled={busy} onClick={() => void remove(address)} className="text-red-600 hover:underline">刪除</button></div></div></article>)}</div>}</section>
    </div>
  );
}

function Input({ label, id, value, onChange, autoComplete, placeholder }: { label: string; id: string; value: string; onChange: (value: string) => void; autoComplete?: string; placeholder?: string }) {
  return <div><label htmlFor={id} className="block text-sm font-medium">{label}</label><input id={id} required type="text" value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} placeholder={placeholder} className="mt-1.5 w-full rounded-lg border border-stone-300 px-3 py-2.5 text-sm outline-none focus:border-stone-600" /></div>;
}
