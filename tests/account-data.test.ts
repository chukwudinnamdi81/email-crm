import test from "node:test";
import assert from "node:assert/strict";
import { db } from "../lib/db";
import { deleteUserData, purgeMailbox } from "../lib/account-data";

// Needs a real Postgres (DATABASE_URL with the schema pushed); skipped otherwise.
let reachable: Promise<boolean> | undefined;
const hasDb = () => (reachable ??= db.$queryRaw`SELECT 1`.then(() => true, () => false));

/** Row counts for every model that can belong to a user, each scoped through its relation chain. */
async function counts(userId: string) {
  const own = { userId };
  const viaAcc = { account: { userId } };
  return {
    user: await db.user.count({ where: { id: userId } }),
    session: await db.session.count({ where: own }),
    authToken: await db.authToken.count({ where: own }),
    mailAccount: await db.mailAccount.count({ where: own }),
    smtpSender: await db.smtpSender.count({ where: own }),
    folder: await db.folder.count({ where: viaAcc }),
    message: await db.message.count({ where: viaAcc }),
    syncJob: await db.syncJob.count({ where: viaAcc }),
    contact: await db.contact.count({ where: own }),
    contactSource: await db.contactSource.count({ where: { contact: { userId } } }),
    verificationResult: await db.verificationResult.count({ where: { contact: { userId } } }),
    sentLog: await db.sentLog.count({ where: own }),
    sequence: await db.sequence.count({ where: own }),
    sequenceStep: await db.sequenceStep.count({ where: { sequence: { userId } } }),
    sequenceEnrollment: await db.sequenceEnrollment.count({ where: { sequence: { userId } } }),
    sequenceSend: await db.sequenceSend.count({ where: { enrollment: { sequence: { userId } } } }),
    unsubscribe: await db.unsubscribe.count({ where: own }),
    aiProfile: await db.aiProfile.count({ where: own }),
    aiUsage: await db.aiUsage.count({ where: own }),
    aiDraft: await db.aiDraft.count({ where: own }),
    autoResponder: await db.autoResponder.count({ where: own }),
    autoReplyLog: await db.autoReplyLog.count({ where: { responder: { userId } } }),
  };
}

async function seed(tag: string) {
  const now = new Date();
  const u = await db.user.create({ data: { email: `${tag}@example.test`, passwordHash: "x", emailVerifiedAt: now } });
  const userId = u.id;
  await db.session.create({ data: { tokenHash: `${tag}-s`, userId, expiresAt: now } });
  await db.authToken.create({ data: { userId, purpose: "EMAIL_VERIFY", tokenHash: `${tag}-t`, expiresAt: now } });
  const sender = await db.smtpSender.create({ data: { userId, label: "s", host: "h", port: 25, security: "NONE", fromName: "n", fromEmail: "f@example.test" } });
  const acc = await db.mailAccount.create({ data: { userId, label: "a", email: "a@example.test", method: "MANUAL", passwordEnc: "enc", defaultSmtpSenderId: sender.id } });
  const folder = await db.folder.create({ data: { accountId: acc.id, path: "INBOX", name: "INBOX", lastUid: 9, backfilled: true, backfillBelow: 4 } });
  const msg = await db.message.create({ data: { accountId: acc.id, folderId: folder.id, uid: 1, receivedAt: now, fromEmail: "c@example.test" } });
  await db.syncJob.create({ data: { accountId: acc.id } });
  const contact = await db.contact.create({ data: { userId, email: "c@example.test", firstSeen: now, lastSeen: now, messageCount: 1 } });
  await db.contactSource.create({ data: { contactId: contact.id, accountId: acc.id, folderPath: "INBOX", count: 1 } });
  await db.verificationResult.create({ data: { contactId: contact.id, email: contact.email, status: "valid" } });
  await db.sentLog.create({ data: { userId, senderId: acc.id, senderType: "ACCOUNT", to: "c@example.test", subject: "s", status: "sent" } });
  const seq = await db.sequence.create({ data: { userId, name: "q" } });
  const step = await db.sequenceStep.create({ data: { sequenceId: seq.id, position: 0, subject: "s", bodyHtml: "b" } });
  const en = await db.sequenceEnrollment.create({ data: { sequenceId: seq.id, contactId: contact.id } });
  await db.sequenceSend.create({ data: { enrollmentId: en.id, stepId: step.id, messageIdHeader: "<x>", status: "sent" } });
  await db.unsubscribe.create({ data: { userId, email: "u@example.test", source: "t" } });
  await db.aiProfile.create({ data: { userId } });
  await db.aiUsage.create({ data: { userId, feature: "f", model: "m", inputTokens: 1, outputTokens: 1 } });
  await db.aiDraft.create({ data: { userId, messageId: msg.id, accountId: acc.id, subject: "s", body: "b" } });
  const resp = await db.autoResponder.create({ data: { userId, accountId: acc.id, name: "r" } });
  await db.autoReplyLog.create({ data: { responderId: resp.id, messageId: msg.id, contactEmail: "c@example.test", decision: "skipped", reason: "t" } });
  return { userId, accountId: acc.id };
}

test("deleteUserData leaves zero rows for the user in every model and keeps other users", async (t) => {
  if (!(await hasDb())) return t.skip("database not reachable");
  const tag = `del-${Date.now()}`;
  const a = await seed(`${tag}-a`);
  const b = await seed(`${tag}-b`);
  const before = await counts(a.userId);
  for (const [model, n] of Object.entries(before)) assert.ok(n > 0, `seed should create ${model}`);
  const otherBefore = await counts(b.userId);

  await deleteUserData(a.userId);

  for (const [model, n] of Object.entries(await counts(a.userId))) assert.equal(n, 0, `${model} rows left`);
  assert.deepEqual(await counts(b.userId), otherBefore);
  await deleteUserData(b.userId);
});

test("purgeMailbox removes synced data but keeps the account, and a fresh sync can start from zero", async (t) => {
  if (!(await hasDb())) return t.skip("database not reachable");
  const s = await seed(`purge-${Date.now()}`);
  const { messages } = await purgeMailbox(s.userId, s.accountId);
  assert.equal(messages, 1);
  const c = await counts(s.userId);
  assert.equal(c.message + c.folder + c.syncJob + c.contactSource, 0);
  assert.equal(c.mailAccount, 1);
  assert.ok((await db.mailAccount.findUniqueOrThrow({ where: { id: s.accountId } })).passwordEnc);
  // contact that has an enrollment is kept but no longer counts purged mail
  assert.equal((await db.contact.findFirstOrThrow({ where: { userId: s.userId } })).messageCount, 0);
  await deleteUserData(s.userId);
});

test.after(() => db.$disconnect());
