"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Acc = { id: string; label: string; email: string; method: string; status: string; lastError: string | null; imapHost: string | null; imapPort: number | null; imapSecurity: string | null; smtpHost: string | null; smtpPort: number | null; smtpSecurity: string | null; username: string | null; passwordMasked: string | null; autoDraft: boolean; defaultSmtpSenderId: string | null };
type Sender = { id: string; label: string; fromEmail: string };
const blank = { label: "", email: "", imapHost: "", imapPort: 993, imapSecurity: "SSL", smtpHost: "", smtpPort: 465, smtpSecurity: "SSL", username: "", password: "" };

export default function Accounts() {
  const [list, setList] = useState<Acc[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [f, setF] = useState(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => { setList((await api<Acc[]>("/api/accounts")).data as unknown as Acc[]); setSenders((await api<Sender[]>("/api/senders")).data as unknown as Sender[]); };
  useEffect(() => { load(); }, []);
  const set = (k: string, v: string | number) => setF({ ...f, [k]: v });
  const setEmail = (v: string) => {
    const gmail = /@(gmail|googlemail)\.com$/i.test(v.trim());
    if (gmail && !f.imapHost && !f.smtpHost) setF({ ...f, email: v, imapHost: "imap.gmail.com", imapPort: 993, imapSecurity: "SSL", smtpHost: "smtp.gmail.com", smtpPort: 465, smtpSecurity: "SSL", username: f.username || v.trim() });
    else set("email", v);
  };

  async function save() {
    setMsg({ ok: true, text: "Testing connection…" });
    const r = editing ? await api<{ status: string; lastError: string | null }>(`/api/accounts/${editing}`, "PATCH", { ...f, password: f.password || undefined }) : await api<{ test: { ok: boolean; imap: string; smtp: string } }>("/api/accounts", "POST", f);
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? "Failed" });
    if (editing) { const d = r.data as unknown as { status: string; lastError: string | null }; setMsg({ ok: d.status !== "error", text: d.lastError ?? "Saved. Connection OK." }); }
    else { const t = (r.data as unknown as { test: { ok: boolean; imap: string; smtp: string } }).test; setMsg({ ok: t.ok, text: t.ok ? "Connected: IMAP login and SMTP verify passed." : `Saved, but test failed. ${t.imap !== "OK" ? t.imap : ""} ${t.smtp !== "OK" ? t.smtp : ""}` }); }
    setEditing(null); setF(blank); load();
  }

  return (
    <>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="mb-1">Mail accounts</h1><p className="text-sm text-muted">Connect the mailboxes you read, reply from and sync.</p></div>
        <div className="row">
          <a href="/api/oauth/start?provider=GOOGLE"><button>Connect Gmail (OAuth)</button></a>
          <a href="/api/oauth/start?provider=MICROSOFT"><button>Connect Outlook / Microsoft 365 (OAuth)</button></a>
        </div>
      </header>
      <div className="card">
        <h3>{editing ? "Edit account" : "Add account (manual IMAP + SMTP)"}</h3>
        <div className="grid">
          <input placeholder="Label" value={f.label} onChange={(e) => set("label", e.target.value)} />
          <input placeholder="Email" value={f.email} onChange={(e) => setEmail(e.target.value)} />
          <input placeholder="Username" value={f.username} onChange={(e) => set("username", e.target.value)} />
          <input type="password" placeholder={editing ? "Password (leave blank to keep)" : "Password / app password"} value={f.password} onChange={(e) => set("password", e.target.value)} />
          <input placeholder="IMAP host" value={f.imapHost} onChange={(e) => set("imapHost", e.target.value)} />
          <input type="number" placeholder="IMAP port" value={f.imapPort} onChange={(e) => set("imapPort", Number(e.target.value))} />
          <select value={f.imapSecurity} onChange={(e) => set("imapSecurity", e.target.value)}><option>SSL</option><option>STARTTLS</option></select>
          <input placeholder="SMTP host" value={f.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} />
          <input type="number" placeholder="SMTP port" value={f.smtpPort} onChange={(e) => set("smtpPort", Number(e.target.value))} />
          <select value={f.smtpSecurity} onChange={(e) => set("smtpSecurity", e.target.value)}><option>SSL</option><option>STARTTLS</option></select>
        </div>
        <p className="text-sm text-muted">Gmail: use a 16-character App Password (needs 2-Step Verification) and make sure IMAP is enabled in Gmail settings.</p>
        {msg && <p className={msg.ok ? "callout-info" : "callout-danger"} role="status">{msg.text}</p>}
        <div className="row"><button onClick={save}>{editing ? "Save & test" : "Add & test"}</button>{editing && <button className="sec" onClick={() => { setEditing(null); setF(blank); }}>Cancel</button>}</div>
      </div>
      {list.length === 0 && <div className="empty-state"><b className="block text-fg">No mail accounts yet</b>Connect Gmail or Outlook above, or add one manually with IMAP + SMTP.</div>}
      {list.map((a) => (
        <div className="card" key={a.id}>
          <div className="row"><b>{a.label}</b> <span className="text-sm text-muted">{a.email} · {a.method}</span>
            <span className={`flex items-center gap-1.5 text-sm ${a.status === "connected" ? "text-success" : a.status === "error" ? "text-danger" : "text-muted"}`}><span className="size-2 rounded-full bg-current" aria-hidden="true" />{a.status}</span></div>
          {a.lastError && <p className="my-1 text-[13px] text-danger">{a.lastError}</p>}
          <div className="row">
            <label className="text-sm">Send via SMTP sender{" "}
              <select value={a.defaultSmtpSenderId ?? ""} onChange={async (e) => { await api(`/api/accounts/${a.id}`, "PATCH", { defaultSmtpSenderId: e.target.value || null }); load(); }}>
                <option value="">Mailbox's own SMTP</option>{senders.map((s) => <option key={s.id} value={s.id}>{s.label} &lt;{s.fromEmail}&gt;</option>)}
              </select></label>
            <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={a.autoDraft} onChange={async (e) => { await api(`/api/accounts/${a.id}`, "PATCH", { autoDraft: e.target.checked }); load(); }} /> Auto-draft replies with AI</label>
          </div>
          <div className="row mt-2">
            <button className="sec" onClick={async () => { const r = await api<{ ok: boolean; imap: string; smtp: string }>(`/api/accounts/${a.id}/test`, "POST"); setMsg({ ok: !!r.data.ok, text: r.data.ok ? "Test passed" : `${r.data.imap} ${r.data.smtp}` }); load(); }}>Test</button>
            {a.method === "MANUAL" && <button className="sec" onClick={() => { setEditing(a.id); setF({ label: a.label, email: a.email, imapHost: a.imapHost ?? "", imapPort: a.imapPort ?? 993, imapSecurity: a.imapSecurity ?? "SSL", smtpHost: a.smtpHost ?? "", smtpPort: a.smtpPort ?? 465, smtpSecurity: a.smtpSecurity ?? "SSL", username: a.username ?? "", password: "" }); }}>Edit</button>}
            <button className="sec" onClick={async () => { await api(`/api/accounts/${a.id}`, "PATCH", { disconnect: true }); load(); }}>Disconnect</button>
            <button className="danger" onClick={async () => { if (confirm("Delete this account and its stored secrets and synced mail?")) { await api(`/api/accounts/${a.id}`, "DELETE"); load(); } }}>Delete</button>
          </div>
        </div>
      ))}
    </>
  );
}
