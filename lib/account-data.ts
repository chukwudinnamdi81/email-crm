import { db } from "./db";
import { rebuildContacts } from "./contacts-rebuild";

/**
 * Hard-deletes everything a user owns, in one transaction. Child rows (messages, folders, sync jobs, steps,
 * enrollments, sends, verification results, ...) go through the schema's onDelete: Cascade; user-owned tables
 * are still listed explicitly and scoped by userId so nothing depends on cascades alone.
 */
export async function deleteUserData(userId: string): Promise<void> {
  await db.$transaction([
    db.session.deleteMany({ where: { userId } }),
    db.authToken.deleteMany({ where: { userId } }),
    db.aiDraft.deleteMany({ where: { userId } }),
    db.aiUsage.deleteMany({ where: { userId } }),
    db.aiProfile.deleteMany({ where: { userId } }),
    db.autoResponder.deleteMany({ where: { userId } }),
    db.sequence.deleteMany({ where: { userId } }),
    db.contact.deleteMany({ where: { userId } }),
    db.sentLog.deleteMany({ where: { userId } }),
    db.unsubscribe.deleteMany({ where: { userId } }),
    db.mailAccount.deleteMany({ where: { userId } }),
    db.smtpSender.deleteMany({ where: { userId } }),
    db.user.deleteMany({ where: { id: userId } }),
  ]);
}

/**
 * Removes a mailbox's synced mail (messages, folders with their sync cursors, sync jobs) and the contact data
 * that came from it. The account and its credentials stay, so the next sync starts from scratch.
 * Mail on the mail server is never touched.
 */
export async function purgeMailbox(userId: string, accountId: string): Promise<{ messages: number }> {
  const owned = { accountId, account: { userId } };
  const [messages] = await db.$transaction([
    db.message.deleteMany({ where: owned }), // also removes AI drafts and auto-reply logs for those messages
    db.folder.deleteMany({ where: owned }), // cursors (lastUid, backfillBelow, backfilled) go with the rows
    db.syncJob.deleteMany({ where: owned }),
    db.contactSource.deleteMany({ where: owned }),
    db.mailAccount.updateMany({ where: { id: accountId, userId }, data: { lastSyncAt: null } }),
  ]);
  // contacts only exist because of synced mail: recompute counts / drop the ones with no remaining source
  await rebuildContacts(userId);
  return { messages: messages.count };
}
