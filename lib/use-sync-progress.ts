"use client";
import { useSyncExternalStore } from "react";
import { emaRate, type Overall, type Progress } from "./sync-progress";

export type SyncJobView = {
  status: string; foldersTotal: number; foldersDone: number; messagesFetched: number; contactsFound: number; currentFolder: string | null;
  error: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; queuedSince: string | null; yieldedAt: string | null;
  progress?: Progress;
};
export type SyncRow = {
  accountId: string; label: string; email: string; status: string; lastSyncAt: string | null; lastError: string | null; syncWindowDays: number | null;
  job: SyncJobView | null;
  folders: { id: string; path: string; specialUse: string | null; total: number; fetched: number; done: boolean; pending: number | null; processed: number }[];
};
export type Smoothed = { ratePerMin: number | null; etaSec: number | null };
export type SyncState = { loaded: boolean; accounts: SyncRow[]; overall: Overall | null; workerAlive: boolean | null; smoothed: Record<string, Smoothed> };

const EMPTY: SyncState = { loaded: false, accounts: [], overall: null, workerAlive: null, smoothed: {} };
let state = EMPTY;
const subs = new Set<() => void>();
const rates = new Map<string, { rate: number; at: number }>();
let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;

function smooth(key: string, rate: number | null, remaining: number, now: number): Smoothed {
  if (rate != null) {
    const prev = rates.get(key);
    rates.set(key, { rate: emaRate(prev?.rate ?? null, rate, prev ? now - prev.at : 0), at: now });
  }
  const r = rates.get(key)?.rate ?? null;
  return { ratePerMin: r, etaSec: r && remaining > 0 ? Math.round((remaining / r) * 60) : null };
}

function schedule() {
  clearTimeout(timer);
  if (!subs.size) return;
  timer = setTimeout(poll, state.overall && state.overall.active > 0 ? 4000 : 30_000);
}

async function poll() {
  if (inflight) return;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // resumes on visibilitychange
  inflight = true;
  try {
    const r = await fetch("/api/sync");
    if (r.ok) {
      const d = (await r.json()) as { accounts: SyncRow[]; overall: Overall; workerAlive: boolean | null };
      const now = Date.now();
      const smoothed: Record<string, Smoothed> = {};
      const live = new Set<string>();
      for (const a of d.accounts) {
        const p = a.job?.progress;
        if (p && (a.job!.status === "running" || a.job!.status === "queued")) {
          live.add(a.accountId);
          smoothed[a.accountId] = smooth(a.accountId, p.phase === "downloading" ? p.ratePerMin : null, p.remaining, now);
        }
      }
      if (d.overall.active > 0) { live.add("overall"); smoothed.overall = smooth("overall", d.overall.ratePerMin, d.overall.remaining, now); }
      for (const k of [...rates.keys()]) if (!live.has(k)) rates.delete(k);
      state = { loaded: true, accounts: d.accounts, overall: d.overall, workerAlive: d.workerAlive, smoothed };
      subs.forEach((f) => f());
    }
  } catch { /* keep the last state */ } finally {
    inflight = false;
    schedule();
  }
}

const onVisible = () => { if (document.visibilityState === "visible") poll(); };

function subscribe(cb: () => void) {
  subs.add(cb);
  if (subs.size === 1) {
    document.addEventListener("visibilitychange", onVisible);
    poll();
  }
  return () => {
    subs.delete(cb);
    if (!subs.size) { clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); }
  };
}

/** Shared by the Sync page and the sidebar pill: one poll loop no matter how many components subscribe. */
export function useSyncProgress(): SyncState & { refresh: () => void } {
  const s = useSyncExternalStore(subscribe, () => state, () => EMPTY);
  return { ...s, refresh: () => { poll(); } };
}
