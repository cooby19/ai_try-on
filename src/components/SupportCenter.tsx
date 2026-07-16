"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import type { SupportCategory, SupportTicketView } from "@/lib/types";

const DATE = new Intl.DateTimeFormat("zh-TW", { dateStyle: "medium", timeStyle: "short" });

export default function SupportCenter({ initialTickets }: { initialTickets: SupportTicketView[] }) {
  const router = useRouter();
  const [category, setCategory] = useState<SupportCategory>("order");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [orderId, setOrderId] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function createTicket(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch("/api/support/tickets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ category, subject, message, orderId: orderId || null }),
      });
      const body = (await response.json()) as { message?: string };
      if (!response.ok) throw new Error(body.message ?? "客服案件建立失敗。");
      setSubject(""); setMessage(""); setOrderId("");
      setNotice("客服案件已建立，我們也會透過 Email 通知進度。");
      router.refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "客服案件建立失敗。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 grid gap-6 lg:grid-cols-[0.9fr_1.1fr]">
      <form onSubmit={createTicket} className="h-fit space-y-3 rounded-2xl border border-stone-200 bg-white p-5">
        <h2 className="font-semibold">建立客服案件</h2>
        <select value={category} onChange={(event) => setCategory(event.target.value as SupportCategory)} className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm">
          <option value="order">訂單</option><option value="payment">付款</option><option value="refund">退款</option>
          <option value="try_on">AI 試穿</option><option value="privacy">隱私</option><option value="account">帳戶</option><option value="other">其他</option>
        </select>
        <input value={orderId} onChange={(event) => setOrderId(event.target.value)} placeholder="訂單 UUID（選填）" className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" />
        <input required minLength={3} maxLength={120} value={subject} onChange={(event) => setSubject(event.target.value)} placeholder="主旨" className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" />
        <textarea required maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="請描述需要協助的內容" className="min-h-32 w-full rounded-lg border border-stone-300 px-3 py-2 text-sm" />
        <button disabled={busy} className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? "送出中…" : "送出案件"}</button>
        {notice && <p role="status" className="text-sm text-stone-600">{notice}</p>}
      </form>
      <section className="space-y-3">
        <h2 className="font-semibold">我的案件</h2>
        {initialTickets.length ? initialTickets.map((ticket) => (
          <details key={ticket.id} className="rounded-xl border border-stone-200 bg-white p-4">
            <summary className="cursor-pointer list-none">
              <div className="flex items-start justify-between gap-4"><div><p className="font-medium">{ticket.subject}</p><p className="mt-1 text-xs text-stone-500">{ticket.ticketNumber} · {DATE.format(new Date(ticket.lastActivityAt))}</p></div><span className="rounded-full bg-stone-100 px-2 py-1 text-xs">{ticketStatus(ticket.status)}</span></div>
            </summary>
            <div className="mt-4 space-y-2 border-t border-stone-100 pt-4">
              {ticket.messages.map((item) => <div key={item.id} className={`rounded-lg p-3 text-sm ${item.senderRole === "customer" ? "bg-stone-50" : "bg-blue-50"}`}><p className="text-xs font-medium text-stone-500">{item.senderRole === "customer" ? "你" : "客服"} · {DATE.format(new Date(item.createdAt))}</p><p className="mt-1 whitespace-pre-wrap">{item.body}</p></div>)}
              {ticket.status !== "closed" && <ReplyForm ticketId={ticket.id} />}
            </div>
          </details>
        )) : <p className="rounded-xl border border-stone-200 bg-white p-6 text-sm text-stone-500">目前沒有客服案件。</p>}
      </section>
    </div>
  );
}

function ReplyForm({ ticketId }: { ticketId: string }) {
  const router = useRouter(); const [message, setMessage] = useState(""); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); const response = await fetch(`/api/support/tickets/${ticketId}/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message }) }); setBusy(false); if (response.ok) { setMessage(""); router.refresh(); } }
  return <form onSubmit={submit} className="flex gap-2 pt-2"><input required maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="補充訊息" className="min-w-0 flex-1 rounded-lg border border-stone-300 px-3 py-2 text-sm" /><button disabled={busy} className="rounded-lg border border-stone-300 px-3 py-2 text-sm">送出</button></form>;
}

function ticketStatus(status: SupportTicketView["status"]): string {
  return ({ open: "待處理", waiting_customer: "等待回覆", in_progress: "處理中", resolved: "已解決", closed: "已關閉" })[status];
}
