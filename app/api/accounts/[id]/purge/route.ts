import { db } from "@/lib/db";
import { authed, HttpError, json } from "@/lib/api";
import { cancelAccountJobs } from "@/lib/queues";
import { purgeMailbox } from "@/lib/account-data";

export const POST = authed<{ id: string }>(async (_req, user, { id }) => {
  if (!(await db.mailAccount.findFirst({ where: { id, userId: user.id }, select: { id: true } }))) throw new HttpError("Not found", 404);
  await cancelAccountJobs([id]);
  const { messages } = await purgeMailbox(user.id, id);
  console.log(`[audit] mailbox synced data purged user=${user.id}`);
  return json({ ok: true, messages });
});
