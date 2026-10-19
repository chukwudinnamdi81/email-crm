import type { AddressObject } from "mailparser";
import { SYNTAX } from "./verify";

export type Addr = { name?: string; address: string };
type Entry = { name?: string; address?: string; group?: Entry[] };

const SYSTEM_LOCAL = /^(mailer-daemon|postmaster)$|^bounces?[+=-]|\+noreply$|^noreply\+/i;
const MAX_ADDR = 254;

export function cleanName(name: string | undefined, address: string): string | undefined {
  let n = (name ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "").replace(/\s*\(via [^)]*\)\s*$/i, "").trim();
  if (!n || n.toLowerCase() === address.toLowerCase()) return undefined;
  return n;
}

export function isSystemAddress(address: string): boolean {
  return SYSTEM_LOCAL.test(address.split("@")[0] ?? "");
}

function flatten(entries: Entry[], out: Entry[] = []): Entry[] {
  for (const e of entries) {
    if (e.group) flatten(e.group, out);
    else out.push(e);
  }
  return out;
}

/** Addresses from a mailparser address header: flattens groups, lowercases, drops invalid/system addresses and cleans names. */
export function addrs(a: AddressObject | AddressObject[] | undefined): Addr[] {
  if (!a) return [];
  const list = Array.isArray(a) ? a : [a];
  const out: Addr[] = [];
  for (const v of flatten(list.flatMap((x) => x.value as Entry[]))) {
    const address = v.address?.trim().toLowerCase();
    if (!address || address.length > MAX_ADDR || !SYNTAX.test(address) || isSystemAddress(address)) continue;
    out.push({ name: cleanName(v.name, address), address });
  }
  return out;
}

/** Folders whose mail must not create contacts: junk, trash, drafts, and Gmail's All Mail (duplicates Inbox/Sent). */
export function skipContactsForFolder(specialUse: string | null | undefined, gmail: boolean): boolean {
  if (specialUse === "\\Junk" || specialUse === "\\Trash" || specialUse === "\\Drafts") return true;
  return gmail && specialUse === "\\All";
}

export const isGmailAccount = (a: { method: string; imapHost: string | null }) =>
  a.method === "GOOGLE" || /(^|\.)(gmail|googlemail)\.com$/i.test(a.imapHost ?? "");

export type ContactAgg = { name?: string; count: number; first: Date; last: Date };

/** Unique, non-own addresses of one message (each address counts once per message). */
export function messageContacts(lists: Addr[][], own: Set<string>): Addr[] {
  const seen = new Set<string>();
  const out: Addr[] = [];
  for (const a of lists.flat()) {
    if (own.has(a.address) || seen.has(a.address)) continue;
    seen.add(a.address);
    out.push(a);
  }
  return out;
}

/** Order-independent aggregation: same messages in any order give the same counts, dates and names (name = the one from the newest message). */
export function aggregateContacts(msgs: { date: Date; contacts: Addr[] }[]): Map<string, ContactAgg & { nameDate?: Date }> {
  const agg = new Map<string, ContactAgg & { nameDate?: Date }>();
  for (const m of msgs) {
    for (const a of m.contacts) {
      const cur = agg.get(a.address);
      if (!cur) {
        agg.set(a.address, { name: a.name, nameDate: a.name ? m.date : undefined, count: 1, first: m.date, last: m.date });
        continue;
      }
      cur.count++;
      if (m.date < cur.first) cur.first = m.date;
      if (m.date > cur.last) cur.last = m.date;
      if (a.name && (!cur.nameDate || m.date > cur.nameDate)) { cur.name = a.name; cur.nameDate = m.date; }
    }
  }
  return agg;
}
