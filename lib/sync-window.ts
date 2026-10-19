import { z } from "zod";

export const WINDOW_OPTIONS = [7, 30, 90, 365] as const;
export const DEFAULT_WINDOW_DAYS = 30;

/** Start-of-day UTC minus one day of margin (IMAP SINCE compares INTERNALDATE by date only). Null = no window. */
export function windowSince(days: number | null, now = new Date()): Date | null {
  if (days == null) return null;
  const startOfDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(startOfDay - (days + 1) * 86_400_000);
}

/** Widening = larger window than before (null = everything). */
export function isWidening(oldDays: number | null, newDays: number | null): boolean {
  if (oldDays == null) return false;
  return newDays == null || newDays > oldDays;
}

/** Where a folder should resume backfilling after the window is widened. Null = nothing to resume (folder never synced; first sync uses the new window). */
export function widenBackfillBelow(i: { existingBelow: number | null; minStoredUid: number | null; lastUid: number }): number | null {
  const c = [i.existingBelow, i.minStoredUid].filter((x): x is number => x != null);
  if (c.length) return Math.min(...c);
  return i.lastUid > 0 ? i.lastUid + 1 : null;
}

/** Allowed values for the API: 7, 30, 90, 365 days or null (everything). */
export const windowSchema = z.union([z.literal(7), z.literal(30), z.literal(90), z.literal(365), z.null()]);
