"use client";
import { useState } from "react";
import { api } from "@/lib/client";
import { formatEta } from "@/lib/sync-progress";
import { useSyncProgress, type SyncRow } from "@/lib/use-sync-progress";

const rank = (f: SyncRow["folders"][number]) => (f.specialUse === "\\Inbox" || f.path.toUpperCase() === "INBOX" ? 0 : f.specialUse === "\\Sent" ? 1 : 2);

function Meter({ percent, text }: { percent: number; text: string }) {
  return (
    <div className="bar" style={{ height: 12 }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={text}>
      <div style={{ width: `${percent}%` }} />
    </div>
  );
}

function duration(a: string | null, b: string | null) {
  if (!a || !b) return "a moment";
  const s = Math.max(0, Math.round((new Date(b).getTime() - new Date(a).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}

function JobStatus({ r, smoothed }: { r: SyncRow; smoothed?: { ratePerMin: number | null; etaSec: number | null } }) {
  const j = r.job;
  if (!j) return null;
  const p = j.progress;
  const window = r.syncWindowDays ? `last ${r.syncWindowDays} days` : "everything";
  if (!p) {
    // rows from before progress existed
    return <p>Job: <b>{j.status}</b> · folders {j.foldersDone}/{j.foldersTotal} · {j.messagesFetched} messages · {j.contactsFound} new contacts{j.currentFolder ? ` · now: ${j.currentFolder}` : ""}</p>;
  }
  if (j.status === "error") return <p className="err">{j.error ?? "Sync failed"}</p>;
  if (j.status === "done") {
    return (
      <>
        <p>Finished in {duration(j.startedAt, j.finishedAt)} · {j.messagesFetched} messages · {j.contactsFound} new contacts</p>
        {j.error && <p className="muted">{j.error}</p>}
      </>
    );
  }
  const phaseText =
    p.phase === "queued" ? "Waiting for the background worker…"
    : p.phase === "connecting" ? "Connecting to your mailbox…"
    : p.phase === "scanning" ? `Counting messages in ${j.foldersTotal} folders…`
    : p.phase === "waiting" ? "Paused briefly so other mailboxes can sync. Resuming shortly."
    : null;
  if (phaseText) return <p role="status">{phaseText}</p>;
  if (p.messagesTotal < 25) return <p role="status">Checking for new mail…</p>; // routine background sync: no big meter
  const rate = smoothed?.ratePerMin, eta = smoothed?.etaSec;
  const text = `${p.messagesProcessed} of ${p.messagesTotal} messages · ${rate != null ? `${Math.round(rate)}/min` : "measuring speed…"} · ${eta != null ? `${formatEta(eta)} left` : "Estimating time…"}`;
  return (
    <div role="status">
      <div className="row"><b>{p.percent}%</b><span className="muted">Syncing: {window}</span></div>
      <Meter percent={p.percent} text={`${p.percent}% — ${text}`} />
      <p className="my-1 text-sm">{text}</p>
      <p className="muted my-1 text-sm">{j.foldersDone} of {j.foldersTotal} folders{j.currentFolder ? ` · now: ${j.currentFolder}` : ""}</p>
      <p className="muted my-1 text-sm">You can leave this page. Syncing continues in the background and mail appears in your inbox as it arrives.</p>
    </div>
  );
}

export default function Sync() {
  const { accounts: rows, workerAlive, smoothed, loaded, refresh } = useSyncProgress();
  const [showEmpty, setShowEmpty] = useState<Record<string, boolean>>({});
  const queuedTooLong = rows.some((r) => r.job?.status === "queued" && !r.job.yieldedAt && r.job.queuedSince && Date.now() - new Date(r.job.queuedSince).getTime() > 60_000);
  // the heartbeat is the source of truth; queue age only matters when the heartbeat can't be read
  const workerDown = workerAlive === false || (workerAlive === null && queuedTooLong);
  return (
    <>
      <h1>Sync</h1>
      {workerDown && <p className="callout-warn" role="alert">The background worker isn&apos;t running, so mail can&apos;t sync. Deploy a second service with SERVICE=worker and the same env vars.</p>}
      <button onClick={async () => { await api("/api/sync", "POST", {}); refresh(); }}>Sync all accounts</button>
      {loaded && rows.length === 0 && <p className="muted">No mail accounts yet.</p>}
      {rows.map((r) => {
        const folders = [...r.folders].sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
        const isEmpty = (f: SyncRow["folders"][number]) => (f.pending ?? f.total) === 0 && f.total === 0;
        const empty = folders.filter(isEmpty);
        const shown = showEmpty[r.accountId] ? folders : folders.filter((f) => !isEmpty(f));
        return (
          <div className="card" key={r.accountId} style={{ marginTop: 10 }}>
            <div className="row"><b>{r.label}</b><span className="muted">{r.email}</span><span>● {r.status}</span>
              <button className="sec" onClick={async () => { await api("/api/sync", "POST", { accountId: r.accountId }); refresh(); }}>Sync this account</button></div>
            <JobStatus r={r} smoothed={smoothed[r.accountId]} />
            {r.job?.status !== "error" && r.lastError && <p className="err">{r.lastError}</p>}
            <p className="muted">Last finished sync: {r.lastSyncAt ? new Date(r.lastSyncAt).toLocaleString() : "never"} (incremental sync runs automatically)</p>
            {shown.map((f) => {
              const runKnown = f.pending != null && r.job?.status !== "done";
              const total = runKnown ? f.pending! : f.total, fetched = runKnown ? f.processed : f.fetched;
              return (
                <div key={f.id} style={{ fontSize: 13 }}>{f.path} {f.done ? "✓" : ""} <span className="muted">{fetched}/{total}</span>
                  <div className="bar"><div style={{ width: `${total ? Math.min(100, (fetched / total) * 100) : f.done ? 100 : 0}%` }} /></div></div>
              );
            })}
            {empty.length > 0 && <button className="sec" onClick={() => setShowEmpty({ ...showEmpty, [r.accountId]: !showEmpty[r.accountId] })}>{showEmpty[r.accountId] ? "Hide empty folders" : `Show empty folders (${empty.length})`}</button>}
          </div>
        );
      })}
    </>
  );
}
