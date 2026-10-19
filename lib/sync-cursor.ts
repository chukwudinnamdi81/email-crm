export type Chunk = {
  uids: number[];
  /** "new" chunks move lastUid up; "backfill" chunks move backfillBelow down (and are historical mail). */
  dir: "asc" | "desc";
  /** Checkpoint to persist after this chunk is stored. */
  cursor: { lastUid?: number; backfillBelow?: number | null };
};

export type FolderPlan = {
  mode: "first" | "resume" | "legacy";
  /** Persist BEFORE downloading anything (first sync only). */
  initial: { lastUid?: number; backfillBelow?: number | null };
  chunks: Chunk[];
};

function split(uids: number[], batch: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < uids.length; i += batch) out.push(uids.slice(i, i + batch));
  return out;
}

/**
 * Two-cursor plan. lastUid: every UID above it is not downloaded yet. backfillBelow: UIDs below it (that match the window) still are not.
 * `topUid` is the folder's true highest UID (uidNext - 1); on a windowed first sync `uids` only holds the window.
 */
export function planFolder(i: { uids: number[]; lastUid: number; backfillBelow: number | null; backfilled: boolean; batch: number; topUid?: number }): FolderPlan {
  const uids = [...new Set(i.uids)];
  if (i.backfillBelow == null && (i.lastUid > 0 || i.backfilled)) {
    const fresh = uids.filter((u) => u > i.lastUid).sort((a, b) => a - b);
    return { mode: "legacy", initial: {}, chunks: split(fresh, i.batch).map((c) => ({ uids: c, dir: "asc", cursor: { lastUid: c[c.length - 1] } })) };
  }
  if (i.backfillBelow == null) {
    const desc = uids.sort((a, b) => b - a);
    const top = i.topUid ?? desc[0] ?? 0;
    const chunks = split(desc, i.batch).map((c, n, all): Chunk => ({
      uids: c, dir: "desc", cursor: { backfillBelow: n === all.length - 1 ? null : c[c.length - 1] },
    }));
    return { mode: "first", initial: { lastUid: top, backfillBelow: desc.length ? desc[0] + 1 : null }, chunks };
  }
  const below = i.backfillBelow;
  const fresh = uids.filter((u) => u > i.lastUid).sort((a, b) => a - b);
  const old = uids.filter((u) => u < below).sort((a, b) => b - a);
  const chunks: Chunk[] = split(fresh, i.batch).map((c) => ({ uids: c, dir: "asc", cursor: { lastUid: c[c.length - 1] } }));
  const oldChunks = split(old, i.batch);
  oldChunks.forEach((c, n) => chunks.push({ uids: c, dir: "desc", cursor: { backfillBelow: n === oldChunks.length - 1 ? null : c[c.length - 1] } }));
  return { mode: "resume", initial: old.length ? {} : { backfillBelow: null }, chunks };
}
