"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";

type Acc = { id: string; label: string; email: string; method: string; status: string; lastError: string | null; imapHost: string | null; imapPort: number | null; imapSecurity: string | null; smtpHost: string | null; smtpPort: number | null; smtpSecurity: string | null; username: string | null; passwordMasked: string | null; autoDraft: boolean; defaultSmtpSenderId: string | null; syncWindowDays: number | null };
type Discovery = { recommended: "GOOGLE" | "MICROSOFT" | "MANUAL"; imap?: { host: string; port: number; security: string }; smtp?: { host: string; port: number; security: string }; usernameStyle: "email" | "localpart"; source: string };
type Form = typeof blank;
type Providers = { google: boolean; microsoft: boolean };
const WINDOWS: [number | null, string][] = [[30, "Last 30 days (recommended)"], [90, "Last 90 days"], [365, "Last year"], [null, "Everything"]];
const windowLabel = (d: number | null) => (d == null ? "everything" : d === 365 ? "last year" : `last ${d} days`);
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const isGmailHost = (h: string) => /(^|\.)(gmail|googlemail)\.com$/i.test(h);
/** Splits the stored error text into reading (IMAP) / sending (SMTP) / other problems. */
function splitErrors(e: string | null) {
  const parts = (e ?? "").split(" | ").filter(Boolean);
  const sending = parts.filter((p) => /^(SMTP|Sending unavailable)/.test(p)).map((p) => p.replace(/^Sending unavailable:\s*/, ""));
  const reading = parts.filter((p) => /^IMAP/.test(p));
  return { reading, sending, other: parts.filter((p) => !/^(SMTP|Sending unavailable|IMAP)/.test(p)) };
}

type Sender = { id: string; label: string; fromEmail: string };
const blank = { label: "", email: "", imapHost: "", imapPort: 993, imapSecurity: "SSL", smtpHost: "", smtpPort: 465, smtpSecurity: "SSL", username: "", password: "" };

export default function Accounts() {
  const [list, setList] = useState<Acc[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  const [f, setF] = useState<Form>(blank);
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [providers, setProviders] = useState<Providers | null>(null);
  const [banner, setBanner] = useState<{ ok: boolean; text: string } | null>(null);
  const [win, setWin] = useState<number | null>(30);
  const [advanced, setAdvanced] = useState(false);
  const [lookup, setLookup] = useState<{ state: "idle" | "looking" | "found" | "oauth" | "failed"; text: string; oauth?: "GOOGLE" | "MICROSOFT" }>({ state: "idle", text: "" });
  const [looked, setLooked] = useState("");
  const load = async () => { setList((await api<Acc[]>("/api/accounts")).data as unknown as Acc[]); setSenders((await api<Sender[]>("/api/senders")).data as unknown as Sender[]); };
  useEffect(() => {
    load();
    api<Providers>("/api/oauth/providers").then((r) => r.ok && setProviders(r.data as Providers));
    const o = new URLSearchParams(window.location.search).get("oauth");
    if (o) {
      setBanner(o === "ok" ? { ok: true, text: "Mailbox connected. Syncing has started." }
        : o === "unavailable" ? { ok: false, text: "Sign-in with that provider isn't set up on this server. Use a password instead." }
        : { ok: false, text: "Couldn't connect. Try again or use a password." });
      window.history.replaceState(null, "", window.location.pathname);
    }
  }, []);
  const set = (k: string, v: string | number) => setF({ ...f, [k]: v });

  /** Looks up server settings for an email address; returns the values to use for a manual account. */
  async function discover(email: string): Promise<Partial<Form> | "oauth" | null> {
    const e = email.trim();
    if (!EMAIL_RE.test(e)) return null;
    setLooked(e);
    setLookup({ state: "looking", text: "Looking up your mail settings…" });
    const r = await api<Discovery>("/api/accounts/discover", "POST", { email: e });
    const d = r.data as Discovery;
    const failed = (text: string) => { setLookup({ state: "failed", text }); setAdvanced(true); return null; };
    if (!r.ok) return failed(r.data.error ?? "Couldn't find settings automatically — enter them below");
    const oauthOk = d.recommended === "GOOGLE" ? providers?.google : d.recommended === "MICROSOFT" ? providers?.microsoft : false;
    if (d.recommended !== "MANUAL" && oauthOk) {
      setLookup({ state: "oauth", text: "", oauth: d.recommended });
      return "oauth";
    }
    // no OAuth for this provider here (or not configured): fall back to server settings + app password
    const imap = d.imap ?? (d.recommended === "GOOGLE" ? { host: "imap.gmail.com", port: 993, security: "SSL" } : d.recommended === "MICROSOFT" ? { host: "outlook.office365.com", port: 993, security: "SSL" } : undefined);
    const smtp = d.smtp ?? (d.recommended === "GOOGLE" ? { host: "smtp.gmail.com", port: 465, security: "SSL" } : d.recommended === "MICROSOFT" ? { host: "smtp.office365.com", port: 587, security: "STARTTLS" } : undefined);
    if (!imap || !smtp) return failed("Couldn't find settings automatically — enter them below");
    const values: Partial<Form> = {
      imapHost: imap.host, imapPort: imap.port, imapSecurity: imap.security, smtpHost: smtp.host, smtpPort: smtp.port, smtpSecurity: smtp.security,
      username: d.usernameStyle === "localpart" ? e.split("@")[0] : e,
    };
    setF((p) => ({ ...p, ...values }));
    setLookup({ state: "found", text: `Found: ${imap.host} / ${smtp.host}` });
    return values;
  }

  async function add() {
    if (!f.email || !f.password) return setMsg({ ok: false, text: "Enter your email and password." });
    let cur: Form = f;
    if (looked !== f.email.trim() || !f.imapHost || !f.smtpHost) {
      const found = await discover(f.email);
      if (found === "oauth") return setMsg({ ok: false, text: "Use the sign-in button above for this address." });
      if (!found) return setMsg({ ok: false, text: "Couldn't find your mail settings automatically. Enter them under Advanced settings, then try again." });
      cur = { ...f, ...found };
    }
    setMsg({ ok: true, text: "Testing connection…" });
    const email = cur.email.trim();
    const r = await api<{ account: { id: string }; test: { ok: boolean; imap: string; smtp: string; imapOk: boolean; smtpOk: boolean } }>("/api/accounts", "POST", { ...cur, email, label: cur.label.trim() || email, username: cur.username || email, syncWindowDays: win });
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? "Failed" });
    const t = r.data.test;
    let text: string, ok = t.ok;
    if (!t.imapOk && (cur.username || email).includes("@")) {
      // some providers want only the part before the @ as the login: retry once
      const retry = await api<{ status: string; lastError: string | null }>(`/api/accounts/${r.data.account.id}`, "PATCH", { username: email.split("@")[0] });
      if (retry.ok && retry.data.status !== "error") { ok = true; text = retry.data.lastError ?? "Connected. Syncing has started."; setMsg({ ok, text }); setF(blank); setLookup({ state: "idle", text: "" }); setLooked(""); load(); return; }
    }
    if (t.ok) text = "Connected: IMAP login and SMTP verify passed. Syncing has started.";
    else if (t.imapOk) { ok = true; text = `Connected for reading mail (syncing has started). Sending unavailable: ${t.smtp}`; }
    else { setAdvanced(true); text = `Saved, but test failed. ${t.imap}`; }
    setMsg({ ok, text });
    setF(blank); setLookup({ state: "idle", text: "" }); setLooked(""); load();
  }

  async function save() {
    if (!editing) return add();
    setMsg({ ok: true, text: "Testing connection…" });
    const r = await api<{ status: string; lastError: string | null }>(`/api/accounts/${editing}`, "PATCH", { ...f, password: f.password || undefined });
    if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? "Failed" });
    const d = r.data as unknown as { status: string; lastError: string | null };
    setMsg({ ok: d.status !== "error", text: d.lastError ?? "Saved. Connection OK." });
    setEditing(null); setF(blank); load();
  }

  const fields = (
    <div className="grid">
      <input placeholder="Username" value={f.username} onChange={(e) => set("username", e.target.value)} />
      <input placeholder="IMAP host" value={f.imapHost} onChange={(e) => set("imapHost", e.target.value)} />
      <input type="number" placeholder="IMAP port" value={f.imapPort} onChange={(e) => set("imapPort", Number(e.target.value))} />
      <select value={f.imapSecurity} onChange={(e) => set("imapSecurity", e.target.value)}><option>SSL</option><option>STARTTLS</option></select>
      <input placeholder="SMTP host" value={f.smtpHost} onChange={(e) => set("smtpHost", e.target.value)} />
      <input type="number" placeholder="SMTP port" value={f.smtpPort} onChange={(e) => set("smtpPort", Number(e.target.value))} />
      <select value={f.smtpSecurity} onChange={(e) => set("smtpSecurity", e.target.value)}><option>SSL</option><option>STARTTLS</option></select>
    </div>
  );
  const gmailHint = <p className="text-sm text-muted">Gmail: use a 16-character App Password (needs 2-Step Verification) and make sure IMAP is enabled in Gmail settings.</p>;
  const noOauth = providers && !providers.google && !providers.microsoft;
  const oauthButton = lookup.oauth && (
    <div className="my-2">
      <a href={`/api/oauth/start?provider=${lookup.oauth}`}><button type="button">Continue with {lookup.oauth === "GOOGLE" ? "Google" : "Microsoft"}</button></a>
      <p className="text-sm text-muted">Gmail and Outlook/Microsoft 365 no longer accept normal passwords over IMAP, so sign-in through the provider is required.</p>
    </div>
  );

  return (
    <>
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div><h1 className="mb-1">Mail accounts</h1><p className="text-sm text-muted">Connect the mailboxes you read, reply from and sync.</p></div>
        <div className="row">
          {providers?.google && <a href="/api/oauth/start?provider=GOOGLE"><button>Connect Gmail (OAuth)</button></a>}
          {providers?.microsoft && <a href="/api/oauth/start?provider=MICROSOFT"><button>Connect Outlook / Microsoft 365 (OAuth)</button></a>}
          {noOauth && <p className="text-sm text-muted">Gmail / Outlook sign-in isn&apos;t set up on this server. Adding a mailbox with a password still works, with settings found automatically.</p>}
        </div>
      </header>
      {banner && <p className={banner.ok ? "callout-info" : "callout-danger"} role="status">{banner.text}</p>}
      <div className="card">
        <h3>{editing ? "Edit account" : "Add account"}</h3>
        {editing ? (
          <>
            <div className="grid">
              <input placeholder="Label" value={f.label} onChange={(e) => set("label", e.target.value)} />
              <input placeholder="Email" value={f.email} onChange={(e) => set("email", e.target.value)} />
              <input type="password" placeholder="Password (leave blank to keep)" value={f.password} onChange={(e) => set("password", e.target.value)} />
            </div>
            {fields}
            {isGmailHost(f.imapHost) && gmailHint}
          </>
        ) : (
          <>
            <div className="grid">
              <input type="email" placeholder="Email" value={f.email} onChange={(e) => set("email", e.target.value)} onBlur={() => { if (f.email.trim() !== looked) discover(f.email); }} />
              {lookup.state !== "oauth" && <input type="password" placeholder="Password / app password" value={f.password} onChange={(e) => set("password", e.target.value)} />}
              <input placeholder="Label (optional)" value={f.label} onChange={(e) => set("label", e.target.value)} />
              <label className="text-sm">Sync history{" "}
                <select value={win ?? ""} onChange={(e) => setWin(e.target.value === "" ? null : Number(e.target.value))}>
                  {WINDOWS.map(([v, l]) => <option key={l} value={v ?? ""}>{l}</option>)}
                </select></label>
            </div>
            <p className="text-sm text-muted">You can load older mail later. Contacts are built from downloaded mail, so a shorter window finds fewer contacts.</p>
            {lookup.text && <p className={lookup.state === "failed" ? "callout-warn" : "text-sm text-muted"} role="status">{lookup.text}</p>}
            {oauthButton}
            <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)}>
              <summary className="cursor-pointer text-sm">Advanced settings (enter IMAP/SMTP manually)</summary>
              {fields}
            </details>
            {isGmailHost(f.imapHost) && lookup.state !== "oauth" && gmailHint}
          </>
        )}
        {msg && <p className={msg.ok ? "callout-info" : "callout-danger"} role="status">{msg.text}</p>}
        <div className="row">
          {(editing || lookup.state !== "oauth") && <button onClick={save}>{editing ? "Save & test" : "Add & test"}</button>}
          {editing && <button className="sec" onClick={() => { setEditing(null); setF(blank); }}>Cancel</button>}
        </div>
      </div>
      {list.length === 0 && <div className="empty-state"><b className="block text-fg">No mail accounts yet</b>Type your email and password above and the server settings are found automatically{providers?.google || providers?.microsoft ? ", or connect Gmail or Outlook with one click" : ""}.</div>}
      {list.map((a) => {
        const errs = splitErrors(a.lastError);
        const live = a.status === "connected" || a.status === "syncing";
        return (
          <div className="card" key={a.id}>
            <div className="row"><b>{a.label}</b> <span className="text-sm text-muted">{a.email} · {a.method}</span>
              <span className={`flex items-center gap-1.5 text-sm ${a.status === "connected" ? "text-success" : a.status === "error" ? "text-danger" : "text-muted"}`}><span className="size-2 rounded-full bg-current" aria-hidden="true" />{a.status}</span></div>
            {(live || a.status === "error") && (
              <div className="my-1 text-[13px]">
                <p className={`my-0.5 ${errs.reading.length ? "text-danger" : "text-success"}`}>Reading: {errs.reading.length ? errs.reading.join(" | ") : a.status === "error" ? "problem" : "OK"}</p>
                <p className={`my-0.5 ${errs.sending.length ? "text-danger" : "text-success"}`}>Sending: {errs.sending.length ? errs.sending.join(" | ") : "OK"}</p>
                {errs.other.map((o) => <p key={o} className="my-0.5 text-danger">{o}</p>)}
              </div>
            )}
            <div className="row">
              <span className="text-sm text-muted">Syncing: {windowLabel(a.syncWindowDays)}</span>
              {a.syncWindowDays != null && (
                <label className="text-sm">Load older mail{" "}
                  <select value="" onChange={async (e) => { if (e.target.value === "") return; await api(`/api/accounts/${a.id}`, "PATCH", { syncWindowDays: e.target.value === "all" ? null : Number(e.target.value) }); load(); }}>
                    <option value="">Choose…</option>
                    {WINDOWS.filter(([v]) => v == null || v > a.syncWindowDays!).map(([v, l]) => <option key={l} value={v ?? "all"}>{v == null ? "Everything" : l.replace(" (recommended)", "")}</option>)}
                  </select></label>
              )}
            </div>
            <div className="row">
              <label className="text-sm">Send via SMTP sender{" "}
                <select value={a.defaultSmtpSenderId ?? ""} onChange={async (e) => { await api(`/api/accounts/${a.id}`, "PATCH", { defaultSmtpSenderId: e.target.value || null }); load(); }}>
                  <option value="">Mailbox's own SMTP</option>{senders.map((s) => <option key={s.id} value={s.id}>{s.label} &lt;{s.fromEmail}&gt;</option>)}
                </select></label>
              <label className="flex items-center gap-1.5 text-sm"><input type="checkbox" checked={a.autoDraft} onChange={async (e) => { await api(`/api/accounts/${a.id}`, "PATCH", { autoDraft: e.target.checked }); load(); }} /> Auto-draft replies with AI</label>
            </div>
            <div className="row mt-2">
              <button className="sec" onClick={async () => { const r = await api<{ ok: boolean; imap: string; smtp: string; imapOk: boolean }>(`/api/accounts/${a.id}/test`, "POST"); setMsg({ ok: !!r.data.imapOk, text: r.data.ok ? "Test passed" : [r.data.imap, r.data.smtp].filter((x) => x !== "OK").join(" | ") }); load(); }}>Test</button>
              {a.method === "MANUAL" && <button className="sec" onClick={() => { setEditing(a.id); setF({ label: a.label, email: a.email, imapHost: a.imapHost ?? "", imapPort: a.imapPort ?? 993, imapSecurity: a.imapSecurity ?? "SSL", smtpHost: a.smtpHost ?? "", smtpPort: a.smtpPort ?? 465, smtpSecurity: a.smtpSecurity ?? "SSL", username: a.username ?? "", password: "" }); }}>Edit</button>}
              <button className="sec" onClick={async () => { await api(`/api/accounts/${a.id}`, "PATCH", { disconnect: true }); load(); }}>Disconnect</button>
              <button className="danger" onClick={async () => { if (confirm("Delete this account and its stored secrets and synced mail?")) { await api(`/api/accounts/${a.id}`, "DELETE"); load(); } }}>Delete</button>
            </div>
          </div>
        );
      })}
    </>
  );
}
