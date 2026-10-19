import { db } from "./db";
import { addrs, aggregateContacts, cleanName, isGmailAccount, messageContacts, skipContactsForFolder, type Addr } from "./contact-extract";
import type { AddressObject } from "mailparser";

type StoredAddr = { name?: string | null; address?: string };
const asAddrs = (v: unknown): Addr[] =>
  (Array.isArray(v) ? (v as StoredAddr[]) : []).flatMap((a) =>
    a?.address ? addrs({ value: [{ name: a.name ?? "", address: a.address }], html: "", text: "" } as AddressObject) : []);

/**
 * Recomputes a user's contacts from already-stored messages with the same rules as sync.
 * Never deletes a contact that has an enrollment, verification result or unsubscribe record.
 */
export async function rebuildContacts(userId: string) {
  const accounts = await db.mailAccount.findMany({ where: { userId }, select: { id: true, email: true, method: true, imapHost: true } });
  const senders = await db.smtpSender.findMany({ where: { userId }, select: { fromEmail: true } });
  const own = new Set([...accounts.map((a) => a.email), ...senders.map((s) => s.fromEmail)].map((e) => e.toLowerCase()));
  const gmail = new Map(accounts.map((a) => [a.id, isGmailAccount(a)]));
  const folders = await db.folder.findMany({ where: { accountId: { in: accounts.map((a) => a.id) } }, select: { id: true, accountId: true, path: true, specialUse: true } });
  const eligible = new Map(folders.filter((f) => !skipContactsForFolder(f.specialUse, gmail.get(f.accountId) ?? false)).map((f) => [f.id, f]));

  const msgs: { date: Date; contacts: Addr[] }[] = [];
  const sources = new Map<string, Map<string, number>>(); // email -> "accountId\u0000path" -> count
  let cursor: string | undefined;
  for (;;) {
    const rows = await db.message.findMany({
      where: { accountId: { in: accounts.map((a) => a.id) }, folderId: { in: [...eligible.keys()] } },
      select: { id: true, folderId: true, fromName: true, fromEmail: true, toAddrs: true, ccAddrs: true, replyToAddrs: true, receivedAt: true },
      orderBy: { id: "asc" }, take: 2000, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (!rows.length) break;
    cursor = rows[rows.length - 1].id;
    for (const m of rows) {
      const f = eligible.get(m.folderId)!;
      const from = m.fromEmail ? asAddrs([{ name: m.fromName, address: m.fromEmail }]) : [];
      const contacts = messageContacts([from, asAddrs(m.toAddrs), asAddrs(m.ccAddrs), asAddrs(m.replyToAddrs)], own);
      msgs.push({ date: m.receivedAt, contacts });
      for (const c of contacts) {
        const k = `${f.accountId}\u0000${f.path}`;
        const per = sources.get(c.address) ?? new Map<string, number>();
        per.set(k, (per.get(k) ?? 0) + 1);
        sources.set(c.address, per);
      }
    }
  }
  const agg = aggregateContacts(msgs);

  let updated = 0, created = 0, removed = 0;
  const existing = await db.contact.findMany({ where: { userId }, include: { _count: { select: { enrollments: true, verifications: true } } } });
  const unsub = new Set((await db.unsubscribe.findMany({ where: { userId }, select: { email: true } })).map((u) => u.email.toLowerCase()));
  const byEmail = new Map(existing.map((c) => [c.email, c]));

  for (const [email, a] of agg) {
    const cur = byEmail.get(email);
    const name = cur?.name ? cleanName(cur.name, email) ?? a.name ?? null : a.name ?? null;
    const c = cur
      ? await db.contact.update({ where: { id: cur.id }, data: { messageCount: a.count, name, firstSeen: a.first, lastSeen: a.last } })
      : await db.contact.create({ data: { userId, email, name, messageCount: a.count, firstSeen: a.first, lastSeen: a.last } });
    cur ? updated++ : created++;
    await db.$transaction([
      db.contactSource.deleteMany({ where: { contactId: c.id } }),
      db.contactSource.createMany({
        data: [...(sources.get(email) ?? [])].map(([k, count]) => ({ contactId: c.id, accountId: k.split("\u0000")[0], folderPath: k.split("\u0000")[1], count })),
      }),
    ]);
  }
  for (const c of existing) {
    if (agg.has(c.email)) continue;
    const protectedRow = c._count.enrollments > 0 || c._count.verifications > 0 || unsub.has(c.email.toLowerCase());
    await db.contactSource.deleteMany({ where: { contactId: c.id } });
    if (protectedRow) await db.contact.update({ where: { id: c.id }, data: { messageCount: 0 } });
    else { await db.contact.delete({ where: { id: c.id } }); removed++; }
  }
  return { updated, created, removed };
}
