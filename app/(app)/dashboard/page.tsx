"use client";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useSyncProgress } from "@/lib/use-sync-progress";

type Onboarding = { accountConnected: boolean; hasSynced: boolean; contactsFound: number; verifiedContacts: number; sequenceCreated: boolean; sequenceTestSent: boolean; sequenceActive: boolean };
const DISMISS_KEY = "onboarding:dismissed";
type D = { accounts: number; contacts: number; senders: number; sequences: number; escalated: number; activeResponders: number; onboarding: Onboarding; autoRepliesPaused: boolean; aiCapNotice: boolean };

export default function Dashboard() {
  const [d, setD] = useState<D | null>(null);
  const { overall } = useSyncProgress();
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => { setDismissed(localStorage.getItem(DISMISS_KEY) === "1"); }, []);
  const load = () => api<D>("/api/dashboard").then((r) => setD(r.data as D));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="space-y-3" aria-busy="true" aria-label="Loading dashboard"><div className="skeleton h-8 w-48" /><div className="skeleton h-20" /><div className="grid mb-4"><div className="skeleton h-24" /><div className="skeleton h-24" /><div className="skeleton h-24" /><div className="skeleton h-24" /></div></div>;
  const stat = (l: string, v: number, href: string) => <a href={href} className="card mb-0 block text-sm text-muted no-underline transition-shadow hover:shadow-lifted hover:no-underline" key={l}><div className="text-4xl font-semibold tracking-tight text-fg">{v}</div>{l}</a>;
  const o = d.onboarding;
  const syncing = !!overall && overall.active > 0;
  const steps: { label: string; done: boolean; href: string; cta: string; note?: string }[] = [
    { label: "Connect a mailbox", done: o.accountConnected, href: "/accounts", cta: "Connect" },
    { label: "Wait for the first sync", done: o.hasSynced, href: "/sync", cta: "View sync", note: syncing && overall ? `Syncing mail · ${overall.percent}%` : undefined },
    { label: "Review your contacts", done: o.contactsFound > 0, href: "/contacts", cta: "Review" },
    { label: "Verify addresses before emailing", done: o.verifiedContacts > 0, href: "/contacts", cta: "Verify" },
    { label: "Create a sequence", done: o.sequenceCreated, href: "/sequences", cta: "Create" },
    { label: "Send yourself a test", done: o.sequenceTestSent, href: "/sequences", cta: "Open sequence" },
    { label: "Activate a sequence", done: o.sequenceActive, href: "/sequences", cta: "Activate" },
  ];
  const doneCount = steps.filter((s) => s.done).length;
  const firstTodo = steps.findIndex((s) => !s.done);
  const showGuide = doneCount < steps.length && (!dismissed || d.accounts === 0);
  return (
    <>
      <header className="mb-4"><h1 className="mb-1">Dashboard</h1><p className="text-sm text-muted">Overview of your mail, contacts and automation.</p></header>
      {showGuide && (
        <section className="card" aria-labelledby="get-started">
          <div className="mb-2 flex items-center justify-between gap-3">
            <h2 id="get-started" className="mb-0">Get started <span className="text-sm font-normal text-muted">{doneCount} of {steps.length} done</span></h2>
            {d.accounts > 0 && <button className="sec" onClick={() => { localStorage.setItem(DISMISS_KEY, "1"); setDismissed(true); }}>Dismiss</button>}
          </div>
          <div className="bar mb-3" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={doneCount} aria-label="Setup progress"><div style={{ width: `${(doneCount / steps.length) * 100}%` }} /></div>
          <ol className="m-0 list-none space-y-2 p-0">
            {steps.map((s, i) => (
              <li key={s.label} className={`flex flex-wrap items-center justify-between gap-2 rounded-lg border p-2 ${i === firstTodo ? "border-brand bg-brand-soft font-medium" : "border-line"}`} aria-current={i === firstTodo ? "step" : undefined}>
                <span><span aria-hidden="true">{s.done ? "✓" : "○"}</span> {s.label}{s.done && <span className="sr-only"> (done)</span>}{!s.done && s.note && <span className="text-sm font-normal text-muted"> · {s.note}</span>}</span>
                <a href={s.href} className={i === firstTodo ? "btn btn-primary" : "text-sm"}>{s.cta}</a>
              </li>
            ))}
          </ol>
        </section>
      )}
      {d.aiCapNotice && <div className="callout-warn">AI daily limit reached: auto-drafting is paused until tomorrow.</div>}
      {d.escalated > 0 && <div className="callout-warn font-medium"><a href="/auto-responders">{d.escalated} message(s) need your attention</a></div>}
      <div className={`card flex flex-wrap items-center justify-between gap-3 ${d.autoRepliesPaused ? "border-danger-line bg-danger-soft" : ""}`}>
        <div><b>Auto-replies:</b> {d.autoRepliesPaused ? <span className="font-semibold text-danger">ALL PAUSED</span> : <span className="font-medium text-success">{d.activeResponders} responder(s) active</span>}</div>
        <button className={d.autoRepliesPaused ? "btn btn-primary" : "btn btn-danger"} onClick={async () => { await api("/api/dashboard", "PUT", { autoRepliesPaused: !d.autoRepliesPaused }); load(); }}>
          {d.autoRepliesPaused ? "Resume all auto-replies" : "Pause all auto-replies"}
        </button>
      </div>
      <div className="grid mb-4">
        {stat("Mail accounts", d.accounts, "/accounts")}{stat("SMTP senders", d.senders, "/senders")}{stat("Contacts", d.contacts, "/contacts")}{stat("Sequences", d.sequences, "/sequences")}
      </div>
    </>
  );
}
