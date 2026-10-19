import { DelayedError, type Job } from "bullmq";
import { simpleParser, AddressObject, ParsedMail } from "mailparser";
import type { MailAccount, Folder } from "@prisma/client";
import { db } from "../lib/db";
import { imapFor } from "../lib/mail/transport";
import { errText } from "../lib/net-guard";
import { emitNewInboxMessage } from "../lib/events";
import { addrs, isGmailAccount, messageContacts, skipContactsForFolder } from "../lib/contact-extract";
import { planFolder } from "../lib/sync-cursor";
import { windowSince } from "../lib/sync-window";
import { shouldYield, syncLimits } from "../lib/sync-limits";
import { acquireLease, refreshLease, releaseLease } from "../lib/sync-lease";
import { sliceDownloadMs } from "../lib/sync-progress";
import { queue, QUEUES } from "../lib/queues";

const BATCH = 50;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Client = Awaited<ReturnType<typeof imapFor>>;
type SyncData = { accountId: string; syncJobId: string };

/** Per-run state shared by processSync and syncFolder. */
type Ctx = {
  job: Job<SyncData>; token?: string; syncJobId: string; userId: string; leaseId: string;
  own: Set<string>; sliceStart: number; scanDoneAt: Date | null; skipped: number;
  /** estimate (total) and handled (done) message counts of this run per folder id */
  est: Map<string, { total: number; done: number }>;
};

function hdr(p: ParsedMail, k: string): string | null {
  const v = p.headers.get(k);
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.join(" ");
  if (typeof v === "object" && "text" in v) return String((v as { text: string }).text);
  return String(v);
}

/** Postgres text/JSON columns reject NUL (\u0000), which shows up in spam and odd MIME. */
const clean = (s?: string | null) => s?.replace(/\u0000/g, "") ?? null;
const cleanJson = <T>(v: T): T => JSON.parse(JSON.stringify(v).replace(/\\u0000/g, "")) as T;

const folderRank = (f: { specialUse: string | null; path: string }) =>
  f.specialUse === "\\Inbox" || f.path.toUpperCase() === "INBOX" ? 0 : f.specialUse === "\\Sent" ? 1 : 2;

export async function processSync(job: Job<SyncData>, token?: string) {
  const { accountId, syncJobId } = job.data;
  const account = await db.mailAccount.findUnique({ where: { id: accountId } });
  if (!account || account.status === "disconnected") {
    await db.syncJob.updateMany({ where: { id: syncJobId }, data: { status: "error", error: "Account unavailable", finishedAt: new Date() } });
    return;
  }
  const leaseId = String(job.id ?? syncJobId);
  if (!(await acquireLease(account.userId, leaseId, syncLimits.perUserConcurrency))) {
    // Another mailbox of this user is already using the slots: wait without consuming a retry.
    console.log(`[sync] lease denied job=${leaseId} user=${account.userId}`);
    await db.syncJob.update({ where: { id: syncJobId }, data: { yieldedAt: new Date() } });
    if (token) {
      await job.moveToDelayed(Date.now() + 10_000 + Math.floor(Math.random() * 5000), token);
      throw new DelayedError();
    }
    return;
  }
  const sj = await db.syncJob.findUniqueOrThrow({ where: { id: syncJobId } });
  const sliceStart = Date.now();
  // a note about sending is kept; everything else from an older test/sync is stale
  const sendNote = account.lastError?.startsWith("Sending unavailable") ? account.lastError : null;
  await db.syncJob.update({
    where: { id: syncJobId },
    data: { status: "running", startedAt: sj.startedAt ?? new Date(), sliceStartedAt: new Date(sliceStart), yieldedAt: null, error: null },
  });
  await db.mailAccount.update({ where: { id: accountId }, data: { status: "syncing", lastError: sendNote } });
  const client = await imapFor(account);
  client.on("error", () => {});
  try {
    await client.connect();
    const boxes = (await client.list()).filter((b) => !b.flags.has("\\Noselect") && !b.flags.has("\\NonExistent"));
    await db.syncJob.update({ where: { id: syncJobId }, data: { foldersTotal: boxes.length } });

    const folders: { path: string; folder: Folder }[] = [];
    for (const b of boxes) {
      const specialUse = b.specialUse ?? (b.path.toUpperCase() === "INBOX" ? "\\Inbox" : null);
      folders.push({
        path: b.path,
        folder: await db.folder.upsert({
          where: { accountId_path: { accountId, path: b.path } },
          create: { accountId, path: b.path, name: b.name, specialUse },
          update: { name: b.name, specialUse },
        }),
      });
    }
    folders.sort((a, b) => folderRank(a.folder) - folderRank(b.folder)); // INBOX, Sent, then the rest

    const senders = await db.smtpSender.findMany({ where: { userId: account.userId }, select: { fromEmail: true } });
    const mine = await db.mailAccount.findMany({ where: { userId: account.userId }, select: { email: true } });
    const ctx: Ctx = {
      job, token, syncJobId, userId: account.userId, leaseId, sliceStart, scanDoneAt: sj.scanDoneAt, skipped: 0,
      own: new Set([...mine.map((a) => a.email), ...senders.map((s) => s.fromEmail)].map((e) => e.toLowerCase())),
      est: new Map(),
    };

    if (!sj.scanDoneAt) {
      const tooBig = await prescan(client, account, folders, ctx);
      if (tooBig) {
        await db.syncJob.update({ where: { id: syncJobId }, data: { status: "error", error: tooBig, finishedAt: new Date() } });
        await db.mailAccount.update({ where: { id: accountId }, data: { status: "connected", lastError: tooBig } });
        return;
      }
    } else {
      for (const f of folders) ctx.est.set(f.folder.id, { total: f.folder.runTotal, done: f.folder.runDone });
    }

    const folderErrors: string[] = [];
    let done = 0;
    for (const { path, folder } of folders) {
      await db.syncJob.update({ where: { id: syncJobId }, data: { currentFolder: path } });
      try {
        await syncFolder(client, account, folder, ctx);
      } catch (e) {
        if (e instanceof DelayedError) throw e;
        folderErrors.push(path);
        console.error(`[sync] folder failed ${path}: ${errText(e)}`);
        // let the bar still reach 100%
        const est = ctx.est.get(folder.id);
        const rest = est ? Math.max(0, est.total - est.done) : 0;
        if (est) est.done = est.total;
        if (rest) await db.syncJob.update({ where: { id: syncJobId }, data: { messagesProcessed: { increment: rest } } });
      }
      done++;
      await db.syncJob.update({ where: { id: syncJobId }, data: { foldersDone: done } });
    }
    if (folders.length > 0 && folderErrors.length === folders.length) throw new Error(`All folders failed to sync (${folderErrors.slice(0, 3).join(", ")})`);
    await db.syncJob.update({
      where: { id: syncJobId },
      data: { status: "done", finishedAt: new Date(), currentFolder: null, error: ctx.skipped ? `${ctx.skipped} messages skipped` : null },
    });
    await db.mailAccount.update({
      where: { id: accountId },
      data: { status: "connected", lastError: folderErrors.length ? `Some folders failed: ${folderErrors.join(", ")}` : sendNote, lastSyncAt: new Date() },
    });
  } catch (e) {
    if (e instanceof DelayedError) throw e; // yielded on purpose; cursors are already saved
    const msg = errText(e);
    const final = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await db.syncJob.update({ where: { id: syncJobId }, data: { status: final ? "error" : "queued", error: msg, ...(final ? { finishedAt: new Date() } : {}) } });
    await db.mailAccount.update({ where: { id: accountId }, data: { status: "error", lastError: msg } });
    throw e; // BullMQ retries with exponential backoff; per-folder progress makes it resume
  } finally {
    await releaseLease(account.userId, leaseId);
    await client.logout().catch(() => {});
  }
}

/** Cheap whole-mailbox count so the progress bar has a grand total. Returns an error text when the optional size guard trips. */
async function prescan(client: Client, account: MailAccount, folders: { path: string; folder: Folder }[], ctx: Ctx): Promise<string | null> {
  const since = windowSince(account.syncWindowDays);
  let total = 0;
  for (const { path, folder } of folders) {
    let estimate = 0;
    try {
      const st = await client.status(path, { messages: true, uidNext: true });
      const messages = st.messages ?? 0;
      const fresh = folder.backfillBelow == null && folder.lastUid === 0 && !folder.backfilled;
      if (fresh && since) {
        const lock = await client.getMailboxLock(path, { readOnly: true });
        try { estimate = ((await client.search({ since }, { uid: true })) || []).length; } finally { lock.release(); }
      } else if (fresh) estimate = messages;
      else if (folder.backfillBelow != null) estimate = Math.max(0, messages - folder.fetched);
      else estimate = Math.min(Math.max(0, messages - folder.fetched), Math.max(0, (st.uidNext ?? 1) - 1 - folder.lastUid));
    } catch {
      estimate = 0; // a failing STATUS just counts as 0
    }
    ctx.est.set(folder.id, { total: estimate, done: 0 });
    total += estimate;
  }
  const limit = syncLimits.maxFullSyncMessages;
  const noCursors = folders.every((f) => f.folder.lastUid === 0 && f.folder.backfillBelow == null);
  if (limit > 0 && account.syncWindowDays == null && noCursors && total > limit) {
    return `This mailbox has ${total} messages. Choose a shorter sync window (Last year or less) and try again.`;
  }
  await Promise.all(folders.map(({ folder }) => db.folder.update({ where: { id: folder.id }, data: { runTotal: ctx.est.get(folder.id)!.total, runDone: 0 } })));
  ctx.scanDoneAt = new Date();
  await db.syncJob.update({ where: { id: ctx.syncJobId }, data: { messagesTotal: total, messagesProcessed: 0, scanDoneAt: ctx.scanDoneAt } });
  return null;
}

async function maybeYield(ctx: Ctx) {
  const elapsedMs = Date.now() - ctx.sliceStart;
  if (elapsedMs <= syncLimits.sliceSeconds * 1000) return; // zero overhead inside the slice
  const c = await queue(QUEUES.sync).getJobCounts("waiting", "prioritized");
  if (!shouldYield({ elapsedMs, sliceSeconds: syncLimits.sliceSeconds, waitingCount: (c.waiting ?? 0) + (c.prioritized ?? 0) }) || !ctx.token) return;
  console.log(`[sync] yield job=${ctx.leaseId} user=${ctx.userId} after=${Math.round(elapsedMs / 1000)}s`);
  const activeMs = sliceDownloadMs({ scanDoneAt: ctx.scanDoneAt, sliceStartedAt: new Date(ctx.sliceStart) }, Date.now());
  await db.syncJob.update({ where: { id: ctx.syncJobId }, data: { activeMs: { increment: activeMs }, yieldedAt: new Date() } });
  await releaseLease(ctx.userId, ctx.leaseId);
  await ctx.job.changePriority({ priority: 15 });
  await ctx.job.moveToDelayed(Date.now() + 1000, ctx.token);
  throw new DelayedError();
}

async function syncFolder(client: Client, account: MailAccount, folder: Folder, ctx: Ctx) {
  const lock = await client.getMailboxLock(folder.path, { readOnly: true });
  try {
    const mb = client.mailbox;
    if (!mb) return;
    const uidValidity = String(mb.uidValidity);
    let { lastUid, backfilled, backfillBelow } = folder;
    if (folder.uidValidity && folder.uidValidity !== uidValidity) {
      // UIDs are no longer valid: re-sync this folder from scratch
      await db.message.deleteMany({ where: { folderId: folder.id } });
      lastUid = 0;
      backfilled = false;
      backfillBelow = null;
    }
    await db.folder.update({ where: { id: folder.id }, data: { uidValidity, lastUid, backfilled, backfillBelow, totalMessages: mb.exists, done: false, ...(lastUid === 0 ? { fetched: 0 } : {}) } });

    // total this run = handled so far + what is still to do; keeps the grand total converging to the truth
    const settle = async (remaining: number) => {
      const est = ctx.est.get(folder.id) ?? { total: 0, done: 0 };
      const delta = est.done + remaining - est.total;
      est.total = est.done + remaining;
      ctx.est.set(folder.id, est);
      if (delta !== 0) await db.syncJob.update({ where: { id: ctx.syncJobId }, data: { messagesTotal: { increment: delta } } });
      await db.folder.update({ where: { id: folder.id }, data: { runTotal: est.total } });
    };
    if (mb.exists === 0) {
      await settle(0);
      await db.folder.update({ where: { id: folder.id }, data: { done: true, backfilled: true, backfillBelow: null } });
      return;
    }

    const legacy = backfillBelow == null && (lastUid > 0 || backfilled);
    const since = windowSince(account.syncWindowDays);
    const query = legacy ? { uid: `${lastUid + 1}:*` } : since ? { since } : { all: true as const };
    const found = (await client.search(query, { uid: true })) || [];
    const topUid = found.reduce((m, u) => (u > m ? u : m), (mb.uidNext ?? 1) - 1); // true top of the folder, not of the filtered window
    const plan = planFolder({ uids: found, lastUid, backfillBelow, backfilled, batch: BATCH, topUid });
    if (plan.mode === "first" || plan.mode === "resume") {
      // set the top cursor BEFORE downloading: anything arriving later counts as new for the next incremental run
      if (Object.keys(plan.initial).length) await db.folder.update({ where: { id: folder.id }, data: plan.initial });
      if (plan.initial.lastUid != null) lastUid = plan.initial.lastUid;
    }
    await settle(plan.chunks.reduce((n, c) => n + c.uids.length, 0));

    const isInbox = folder.specialUse === "\\Inbox";
    const skipContacts = skipContactsForFolder(folder.specialUse, isGmailAccount(account));
    for (const chunk of plan.chunks) {
      const fetched: { uid: number; flags: string[]; source: Buffer; date: Date }[] = [];
      for await (const m of client.fetch(chunk.uids.join(","), { uid: true, flags: true, source: true, internalDate: true }, { uid: true })) {
        if (m.source) fetched.push({ uid: m.uid, flags: [...(m.flags ?? [])], source: m.source, date: m.internalDate instanceof Date ? m.internalDate : new Date() });
      }
      // Newest-first backfill and "load older mail" are historical: never notify or auto-reply for them.
      // Mail that arrives mid-backfill (uid > lastUid) is stored with isNew=false until the folder finishes; that is acceptable.
      const r = await storeBatch(account, folder, fetched, backfilled && chunk.dir === "asc", isInbox, skipContacts, ctx.own);
      ctx.skipped += r.skipped;
      // single checkpoint per batch so a crash resumes at the right place
      await db.folder.update({ where: { id: folder.id }, data: { ...chunk.cursor, fetched: { increment: r.stored }, runDone: { increment: chunk.uids.length } } });
      const est = ctx.est.get(folder.id);
      if (est) est.done += chunk.uids.length;
      await db.syncJob.update({
        where: { id: ctx.syncJobId },
        data: { messagesProcessed: { increment: chunk.uids.length }, messagesFetched: { increment: r.stored }, contactsFound: { increment: r.newContacts } },
      });
      await refreshLease(ctx.userId, ctx.leaseId, syncLimits.perUserConcurrency);
      await maybeYield(ctx); // checkpoint first, then yield
      await sleep(250); // be gentle with provider rate limits
    }
    await db.folder.update({ where: { id: folder.id }, data: { done: true, backfilled: true, backfillBelow: null } });
  } finally {
    lock.release();
  }
}

async function storeBatch(
  account: MailAccount, folder: Folder,
  items: { uid: number; flags: string[]; source: Buffer; date: Date }[],
  isNew: boolean, isInbox: boolean, skipContacts: boolean, own: Set<string>,
) {
  let newContacts = 0, skipped = 0;
  const stored: Awaited<ReturnType<typeof db.message.create>>[] = [];
  for (const it of items) {
    try {
      if (await db.message.findUnique({ where: { folderId_uid: { folderId: folder.id, uid: it.uid } }, select: { id: true } })) continue;
      const p = await simpleParser(it.source);
      const from = addrs(p.from);
      const to = addrs(p.to), cc = addrs(p.cc), replyTo = addrs(p.replyTo);
      const bcc = addrs((p as ParsedMail & { bcc?: AddressObject }).bcc);
      const date = p.date ?? it.date;
      const headEnd = it.source.indexOf("\r\n\r\n");
      const contacts = skipContacts ? [] : messageContacts([from, to, cc, bcc, replyTo], own);
      // message and its contacts commit together, so a retry can never find the message without its contacts
      const res = await db.$transaction(async (tx) => {
        const msg = await tx.message.create({
          data: {
            accountId: account.id, folderId: folder.id, uid: it.uid,
            messageIdHeader: clean(p.messageId), inReplyTo: clean(p.inReplyTo),
            references: clean(Array.isArray(p.references) ? p.references.join(" ") : p.references),
            listId: clean(hdr(p, "list-id")), listUnsubscribe: clean(hdr(p, "list-unsubscribe")), precedence: clean(hdr(p, "precedence")),
            autoSubmitted: clean(hdr(p, "auto-submitted")), xAutoResponseSuppress: clean(hdr(p, "x-auto-response-suppress")),
            rawHeaders: clean(it.source.subarray(0, headEnd > 0 ? headEnd : 8192).toString("utf8").slice(0, 65536)),
            subject: clean(p.subject), fromName: clean(from[0]?.name), fromEmail: clean(from[0]?.address),
            toAddrs: cleanJson(to), ccAddrs: cleanJson(cc), replyToAddrs: cleanJson(replyTo),
            textBody: clean(p.text), htmlBody: clean(typeof p.html === "string" ? p.html : null),
            attachments: cleanJson(p.attachments.map((a) => ({ filename: a.filename ?? null, contentType: a.contentType, size: a.size }))),
            flags: it.flags, receivedAt: date, isNew,
          },
        });
        let created = 0;
        for (const c of contacts) {
          const key = { userId: account.userId, email: c.address };
          const existed = await tx.contact.findUnique({ where: { userId_email: key }, select: { id: true } });
          const row = await tx.contact.upsert({
            where: { userId_email: key },
            create: { ...key, name: c.name ?? null, messageCount: 1, firstSeen: date, lastSeen: date },
            update: { messageCount: { increment: 1 } },
          });
          if (!existed) created++;
          if ((!row.name && c.name) || date < row.firstSeen || date > row.lastSeen) {
            await tx.contact.update({
              where: { id: row.id },
              data: { name: row.name || c.name || null, firstSeen: date < row.firstSeen ? date : undefined, lastSeen: date > row.lastSeen ? date : undefined },
            });
          }
          await tx.contactSource.upsert({
            where: { contactId_accountId_folderPath: { contactId: row.id, accountId: account.id, folderPath: folder.path } },
            create: { contactId: row.id, accountId: account.id, folderPath: folder.path, count: 1 },
            update: { count: { increment: 1 } },
          });
        }
        return { msg, created };
      }, { timeout: 30_000 });
      stored.push(res.msg);
      newContacts += res.created;
    } catch (e) {
      skipped++;
      console.error(`[sync] skip uid=${it.uid} folder=${folder.path}: ${errText(e)}`);
    }
  }
  if (isNew && isInbox) for (const m of stored) await emitNewInboxMessage({ ...m, userId: account.userId });
  return { stored: stored.length, skipped, newContacts };
}
