import { db } from "./db";

const PAGE = 1000;
const MESSAGE_PAGE = 200; // bodies are large

/** Walks a table in id order so the export never holds more than one page in memory. */
async function* paged<T extends { id: string }>(fetch: (cursor: { id: string } | undefined, take: number) => Promise<T[]>, take = PAGE): AsyncGenerator<T[]> {
  let cursor: { id: string } | undefined;
  for (;;) {
    const rows = await fetch(cursor, take);
    if (!rows.length) return;
    yield rows;
    cursor = { id: rows[rows.length - 1].id };
    if (rows.length < take) return;
  }
}

async function* jsonArray<T extends { id: string }>(key: string, first: boolean, fetch: (cursor: { id: string } | undefined, take: number) => Promise<T[]>): AsyncGenerator<string> {
  yield `${first ? "" : ","}${JSON.stringify(key)}:[`;
  let n = 0;
  for await (const rows of paged(fetch)) for (const r of rows) yield `${n++ ? "," : ""}${JSON.stringify(r)}`;
  yield "]";
}

const page = (cursor: { id: string } | undefined) => ({ orderBy: { id: "asc" as const }, ...(cursor ? { cursor, skip: 1 } : {}) });

/** The user's data as one JSON document (no passwords, tokens or API keys). Messages are a separate export. */
export async function* exportJson(userId: string): AsyncGenerator<string> {
  const user = await db.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, email: true, createdAt: true, emailVerifiedAt: true, googleSub: true, aiProvider: true, aiModel: true, autoRepliesPaused: true, aiProfile: true },
  });
  const accounts = await db.mailAccount.findMany({
    where: { userId },
    select: {
      id: true, label: true, email: true, method: true, imapHost: true, imapPort: true, imapSecurity: true, smtpHost: true, smtpPort: true, smtpSecurity: true,
      username: true, status: true, lastError: true, lastTestedAt: true, lastSyncAt: true, defaultSmtpSenderId: true, autoDraft: true, syncWindowDays: true, createdAt: true,
    },
  });
  const senders = await db.smtpSender.findMany({
    where: { userId },
    select: { id: true, label: true, host: true, port: true, security: true, username: true, fromName: true, fromEmail: true, replyTo: true, isDefault: true, status: true, dailyLimit: true, createdAt: true },
  });
  const sequences = await db.sequence.findMany({ where: { userId }, include: { steps: { orderBy: { position: "asc" } } } });
  const autoResponders = await db.autoResponder.findMany({ where: { userId } });

  yield `{"exportedAt":${JSON.stringify(new Date().toISOString())},"profile":${JSON.stringify(user)},"mailAccounts":${JSON.stringify(accounts)},"smtpSenders":${JSON.stringify(senders)},"sequences":${JSON.stringify(sequences)},"autoResponders":${JSON.stringify(autoResponders)}`;
  yield* jsonArray("contacts", false, (c, take) =>
    db.contact.findMany({ where: { userId }, include: { sources: true, verifications: true }, take, ...page(c) }));
  yield* jsonArray("sequenceEnrollments", false, (c, take) =>
    db.sequenceEnrollment.findMany({ where: { sequence: { userId } }, include: { sends: true }, take, ...page(c) }));
  yield* jsonArray("sendsLog", false, (c, take) => db.sentLog.findMany({ where: { userId }, take, ...page(c) }));
  yield* jsonArray("unsubscribes", false, (c, take) => db.unsubscribe.findMany({ where: { userId }, take, ...page(c) }));
  yield* jsonArray("aiDrafts", false, (c, take) => db.aiDraft.findMany({ where: { userId }, take, ...page(c) }));
  yield* jsonArray("autoReplyLogs", false, (c, take) => db.autoReplyLog.findMany({ where: { responder: { userId } }, take, ...page(c) }));
  yield "}";
}

/** One synced message per line (NDJSON), streamed page by page. */
export async function* exportMessages(userId: string): AsyncGenerator<string> {
  for await (const rows of paged((c, take) => db.message.findMany({ where: { account: { userId } }, include: { folder: { select: { path: true } } }, take, ...page(c) }), MESSAGE_PAGE)) {
    for (const { folder, ...m } of rows) yield `${JSON.stringify({ ...m, folderPath: folder.path })}\n`;
  }
}

export function toStream(it: AsyncGenerator<string>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await it.next();
        if (done) controller.close();
        else controller.enqueue(enc.encode(value));
      } catch (e) {
        console.error("export stream error", e instanceof Error ? e.message : "unknown");
        controller.error(e);
      }
    },
    async cancel() {
      await it.return(undefined);
    },
  });
}
