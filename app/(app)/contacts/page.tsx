"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type C = { id: string; email: string; name: string | null; messageCount: number; lastSeen: string; verificationStatus: string | null; accounts: string[] };
type Seq = { id: string; name: string };
type Acc = { id: string; label: string };
const VERIFY_BADGE: Record<string, string> = { valid: "badge-success", invalid: "badge-danger", risky: "badge-warn", unknown: "badge-neutral", unverified: "badge-neutral" };

export default function Contacts() {
  const [rows, setRows] = useState<C[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState(""), [status, setStatus] = useState(""), [accountId, setAccountId] = useState("");
  const [sort, setSort] = useState("lastSeen"), [dir, setDir] = useState("desc"), [page, setPage] = useState(1);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [accs, setAccs] = useState<Acc[]>([]), [seqs, setSeqs] = useState<Seq[]>([]);
  const [port25, setPort25] = useState<{ checked: boolean; reachable?: boolean; detail?: string } | null>(null);
  const [hideInvalid, setHideInvalid] = useState(false);
  const [note, setNote] = useState("");
  const [loaded, setLoaded] = useState(false);
  const qs = () => new URLSearchParams({ q, status, accountId, sort, dir, page: String(page), ...(hideInvalid ? { hideInvalid: "1" } : {}) });
  const load = async () => { const r = await api<{ rows: C[]; total: number }>(`/api/contacts?${qs()}`); setRows(r.data.rows ?? []); setTotal(r.data.total ?? 0); setLoaded(true); };
  useEffect(() => { load(); }, [q, status, accountId, sort, dir, page, hideInvalid]); // eslint-disable-line
  useEffect(() => {
    api<Acc[]>("/api/accounts").then((r) => setAccs(r.data as unknown as Acc[]));
    api<Seq[]>("/api/sequences").then((r) => setSeqs(r.data as unknown as Seq[]));
    api<{ checked: boolean; reachable?: boolean; detail?: string }>("/api/verify").then((r) => setPort25(r.data));
  }, []);
  const th = (k: string, l: string) => <th className="cursor-pointer select-none whitespace-nowrap" onClick={() => { setDir(sort === k && dir === "desc" ? "asc" : "desc"); setSort(k); }}>{l}{sort === k ? (dir === "asc" ? " ▲" : " ▼") : ""}</th>;
  const toggle = (id: string) => { const n = new Set(sel); n.has(id) ? n.delete(id) : n.add(id); setSel(n); };
  const filterQs = () => { const p = qs(); p.delete("page"); p.delete("sort"); p.delete("dir"); return p.toString(); };

  async function verify(all: boolean) {
    const r = await api<{ queued: number }>("/api/verify", "POST", all ? { all: true, filter: filterQs() } : { ids: [...sel] });
    setNote(`Queued ${r.data.queued} address(es) for verification. Results appear here as the worker finishes.`);
  }
  async function addToSeq(id: string) {
    let r = await api<{ needsConfirmation?: boolean; warn?: { risky: number; unknown: number }; enrolled?: number; skipped?: Record<string, number> }>(`/api/sequences/${id}/enroll`, "POST", { contactIds: [...sel] });
    if (r.data.needsConfirmation) {
      const w = r.data.warn!;
      const inc = confirm(`${w.risky} risky and ${w.unknown} unverified/unknown contact(s). OK = include them, Cancel = exclude them.`);
      r = await api(`/api/sequences/${id}/enroll`, "POST", { contactIds: [...sel], includeRisky: inc, includeUnknown: inc });
    }
    setNote(r.ok ? `Enrolled ${r.data.enrolled}. Skipped: ${Object.entries(r.data.skipped ?? {}).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") || "none"}` : r.data.error ?? "Failed");
  }

  return (
    <>
      <header className="mb-4"><h1 className="mb-1">Contacts <span className="text-base font-normal text-muted">({total})</span></h1><p className="text-sm text-muted">Everyone you have exchanged mail with. Verify addresses, export, or enrol them in a sequence.</p></header>
      {port25 && port25.checked && !port25.reachable && <div className="callout-warn"><b>Outbound port 25 appears blocked</b> on the worker host ({port25.detail}). Email verification will return “unknown”. Railway, Render and Fly commonly block port 25; run the worker on a host that allows it.</div>}
      <div className="card row">
        <input className="min-w-56 flex-1" placeholder="Search name or email" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} />
        <select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Any verification</option>{["valid", "invalid", "risky", "unknown", "unverified"].map((s) => <option key={s}>{s}</option>)}</select>
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)}><option value="">All accounts</option>{accs.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select>
        <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={hideInvalid} onChange={(e) => setHideInvalid(e.target.checked)} /> Hide invalid (also excludes from export)</label>
      </div>
      <div className={`row mb-3 rounded-xl border p-3 ${sel.size ? "border-brand bg-brand-soft" : "border-line bg-surface"}`}>
        <span className="text-sm font-medium">{sel.size ? `${sel.size} selected` : "Bulk actions"}</span>
        <button className="sec" disabled={!sel.size} onClick={() => verify(false)}>Verify selected ({sel.size})</button>
        <button className="sec" onClick={() => verify(true)}>Verify all (filtered)</button>
        <a href={`/api/contacts/export?${filterQs()}${sel.size ? `&ids=${[...sel].join(",")}` : ""}`}><button className="sec">Export CSV</button></a>
        <button className="sec" onClick={async () => {
          if (!confirm("Rebuild contacts from your synced mail? Counts and names are recomputed; contacts that are in a sequence, verified or unsubscribed are never deleted.")) return;
          setNote("Rebuilding contacts…");
          const r = await api<{ updated: number; created: number; removed: number }>("/api/contacts/rebuild", "POST", {});
          setNote(r.ok ? `Rebuilt: ${r.data.updated} updated, ${r.data.created} added, ${r.data.removed} removed.` : r.data.error ?? "Rebuild failed");
          load();
        }}>Rebuild from synced mail</button>
        <select disabled={!sel.size} value="" onChange={(e) => e.target.value && addToSeq(e.target.value)}><option value="">Add to sequence…</option>{seqs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
      </div>
      {note && <p className="callout-info" role="status">{note}</p>}
      <div className="table-wrap"><table>
        <thead><tr><th></th>{th("name", "Name")}{th("email", "Email")}<th>Source account</th>{th("messageCount", "Messages")}{th("lastSeen", "Last contacted")}{th("verificationStatus", "Verification")}</tr></thead>
        <tbody>{rows.map((c) => (
          <tr key={c.id}><td><input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} /></td>
            <td><a href={`/contacts/${c.id}`}>{c.name ?? "—"}</a></td><td>{c.email}</td><td>{c.accounts.join(", ")}</td><td>{c.messageCount}</td>
            <td>{new Date(c.lastSeen).toLocaleDateString()}</td><td><span className={VERIFY_BADGE[c.verificationStatus ?? "unverified"] ?? "badge-neutral"}>{c.verificationStatus ?? "unverified"}</span></td></tr>
        ))}</tbody>
      </table></div>
      {!loaded && <div className="space-y-2" aria-busy="true"><div className="skeleton h-8" /><div className="skeleton h-8" /></div>}
      {loaded && rows.length === 0 && <div className="empty-state"><b className="block text-fg">No contacts yet</b>Contacts appear here once a mail account has synced, or adjust your filters. {accs.length === 0 ? <a href="/accounts">Connect a mail account</a> : <a href="/sync">Check sync progress</a>}.</div>}
      <div className="row mt-3"><button className="sec" disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button><span className="text-sm text-muted">Page {page}</span><button className="sec" disabled={page * 50 >= total} onClick={() => setPage(page + 1)}>Next</button></div>
    </>
  );
}
