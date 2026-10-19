"use client";
import { formatEta } from "@/lib/sync-progress";
import { useSyncProgress } from "@/lib/use-sync-progress";

/** Compact global sync indicator; hidden when idle and for tiny background syncs. */
export default function SyncStatusPill({ compact = false }: { compact?: boolean }) {
  const { overall, smoothed } = useSyncProgress();
  if (!overall || overall.active === 0 || overall.messagesTotal < 25) return null;
  const waiting = overall.phase === "waiting";
  const eta = smoothed.overall?.etaSec;
  const text = waiting ? "Syncing mail · paused briefly" : `Syncing mail · ${overall.percent}%${eta != null ? ` · ~${formatEta(eta).replace("about ", "")} left` : ""}`;
  return (
    <a href="/sync" className="block rounded-lg border border-line bg-surface-muted px-2.5 py-2 text-xs text-fg no-underline hover:no-underline" title="Open sync progress">
      <span className={compact ? "sr-only" : "block truncate"}>{text}</span>
      <div className={compact ? "bar w-24" : "bar mt-1.5"} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall.percent} aria-valuetext={text}>
        <div style={{ width: `${overall.percent}%` }} />
      </div>
    </a>
  );
}
