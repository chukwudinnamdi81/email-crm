"use client";
import { useState } from "react";
import { api } from "@/lib/client";

export default function AccountData() {
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirm, setConfirm] = useState(""), [password, setPassword] = useState(""), [code, setCode] = useState("");
  const [useCode, setUseCode] = useState(false);

  async function exportJson() {
    const r = await fetch("/api/account/export", { method: "POST" });
    if (!r.ok) return setMsg({ ok: false, text: ((await r.json().catch(() => ({}))) as { error?: string }).error ?? "Export failed" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(await r.blob());
    a.download = `mail-crm-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    setMsg({ ok: true, text: "Export downloaded." });
  }
  async function sendCode() {
    const r = await api("/api/account/delete-code", "POST");
    if (r.ok) setUseCode(true);
    setMsg({ ok: r.ok, text: r.ok ? "We emailed you a 6-digit code." : r.data.error ?? "Failed" });
  }
  async function del() {
    if (!window.confirm("Permanently delete your account and all your data? This cannot be undone.")) return;
    const r = await api("/api/account", "DELETE", { confirm, ...(useCode ? { code } : { password }) });
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? "Failed" });
    window.location.href = "/";
  }

  return (
    <>
      <h1>Account &amp; data</h1>
      <div className="card">
        <h3>Export your data</h3>
        <p className="text-sm text-muted">Download your profile, mail accounts (without passwords or tokens), contacts, sequences, sends log, unsubscribes and auto-responders as JSON. Synced messages are a separate file because it can be very large. Limited to 3 exports per hour.</p>
        <div className="row">
          <button className="sec" onClick={exportJson}>Export data (JSON)</button>
          <form method="POST" action="/api/account/export?messages=1"><button className="sec" type="submit">Export messages (NDJSON)</button></form>
        </div>
      </div>
      {msg && <p className={msg.ok ? "callout-info" : "callout-danger"} role="status">{msg.text}</p>}
      <div className="card">
        <h3 className="text-danger">Danger zone</h3>
        <p className="text-sm text-muted">Deleting your account immediately and permanently removes your synced mail, contacts, sequences, sender settings and connected mailbox credentials. Mail on your own mail servers is not touched.</p>
        <div className="grid">
          {useCode
            ? <input inputMode="numeric" maxLength={6} placeholder="6-digit code from your email" value={code} onChange={(e) => setCode(e.target.value)} />
            : <input type="password" placeholder="Current password" value={password} onChange={(e) => setPassword(e.target.value)} />}
          <input placeholder='Type "DELETE" to confirm' value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <div className="row">
          <button className="danger" disabled={confirm !== "DELETE" || !(useCode ? code : password)} onClick={del}>Delete account</button>
          <button className="sec" type="button" onClick={useCode ? () => setUseCode(false) : sendCode}>{useCode ? "Use password instead" : "Signed in with Google? Email me a code"}</button>
        </div>
      </div>
    </>
  );
}
