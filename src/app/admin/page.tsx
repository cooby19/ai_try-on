import { redirect } from "next/navigation";
import { getOperationsDashboard, requireStaff } from "@/lib/staff";
import { replySupportAction, reviewRefundAction, updateRiskAction } from "./actions";

export const metadata = { title: "營運後台｜樣衣間" };
export const dynamic = "force-dynamic";

export default async function AdminPage() {
  try { await requireStaff(["admin", "operations", "support", "risk_analyst"]); } catch { redirect("/"); }
  const data = await getOperationsDashboard();
  return (
    <div className="mx-auto max-w-6xl">
      <p className="text-sm font-medium text-stone-500">受控權限</p><h1 className="mt-1 text-3xl font-semibold">營運後台</h1>
      <p className="mt-2 text-sm text-stone-500">退款、客服、風險與帳戶刪除工作佇列；每項敏感操作都會保留稽核紀錄。</p>
      <div className="mt-8 grid gap-6 xl:grid-cols-2">
        <Queue title={`退款／取消（${data.refunds.length}）`}>
          {data.refunds.map((item) => <div key={item.id} className="rounded-lg bg-stone-50 p-3 text-sm"><p className="font-medium">{orderNumber(item.orders)} · {item.request_type === "cancellation" ? "取消" : "退款"}</p><p className="mt-1 text-stone-500">申請金額 NT${Number(item.requested_amount).toLocaleString()} · {item.status}</p><p className="mt-1 line-clamp-2 text-xs text-stone-500">{item.reason}</p><form action={reviewRefundAction} className="mt-3 grid gap-2 sm:grid-cols-2"><input type="hidden" name="requestId" value={item.id} /><input name="approvedAmount" type="number" min="0" step="1" placeholder="核准金額" className="rounded border px-2 py-1" /><input name="note" maxLength={2000} placeholder="審核說明" className="rounded border px-2 py-1" /><select name="action" className="rounded border px-2 py-1"><option value="approve">核准</option><option value="reject">拒絕</option><option value="mark_processing">已送金流</option><option value="mark_succeeded">退款成功</option><option value="mark_failed">退款失敗</option></select><button className="rounded bg-stone-900 px-3 py-1 text-white">執行</button></form></div>)}
        </Queue>
        <Queue title={`客服（${data.tickets.length}）`}>
          {data.tickets.map((ticket) => <div key={ticket.id} className="rounded-lg bg-stone-50 p-3 text-sm"><p className="font-medium">{ticket.ticket_number} · {ticket.subject}</p><p className="text-xs text-stone-500">{ticket.priority} · {ticket.status}</p><form action={replySupportAction} className="mt-3 grid gap-2"><input type="hidden" name="ticketId" value={ticket.id} /><textarea required name="message" maxLength={5000} placeholder="公開回覆" className="rounded border px-2 py-1" /><div className="flex gap-2"><select name="status" className="rounded border px-2 py-1"><option value="in_progress">處理中</option><option value="waiting_customer">等待客戶</option><option value="resolved">已解決</option><option value="closed">關閉</option></select><button className="rounded bg-stone-900 px-3 py-1 text-white">回覆</button></div></form></div>)}
        </Queue>
        <Queue title={`風險事件（${data.risks.length}）`}>
          {data.risks.map((event) => <div key={event.id} className="rounded-lg bg-stone-50 p-3 text-sm"><p className="font-medium">[{event.severity}] {event.event_type}</p><p className="mt-1 break-all text-xs text-stone-500">{JSON.stringify(event.details)}</p><form action={updateRiskAction} className="mt-2 flex gap-2"><input type="hidden" name="eventId" value={event.id} /><select name="status" className="rounded border px-2 py-1"><option value="investigating">調查中</option><option value="resolved">已處理</option><option value="false_positive">誤報</option></select><button className="rounded border px-3 py-1">更新</button></form></div>)}
        </Queue>
        <Queue title={`帳戶刪除（${data.deletions.length}）`}>
          {data.deletions.map((item) => <div key={item.id} className="rounded-lg bg-stone-50 p-3 text-sm"><p className="font-medium">申請 {item.id}</p><p className="mt-1 text-xs text-stone-500">使用者 {item.user_id} · {item.status}</p><p className="mt-1 text-xs">{item.reason || "未提供原因"}</p></div>)}
          <p className="text-xs text-amber-700">帳戶刪除會先檢查未完成訂單與退款，再由保留政策工作執行；不可在此直接跳過安全檢查。</p>
        </Queue>
      </div>
    </div>
  );
}

function Queue({ title, children }: { title: string; children: React.ReactNode }) { return <section className="rounded-2xl border border-stone-200 bg-white p-5"><h2 className="font-semibold">{title}</h2><div className="mt-4 space-y-3">{children}</div></section>; }
function orderNumber(value: unknown): string { const row = Array.isArray(value) ? value[0] : value; return row && typeof row === "object" && "order_number" in row ? String(row.order_number) : "訂單"; }
