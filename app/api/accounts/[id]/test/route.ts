import { db } from "@/lib/db";
import { authed, HttpError, json } from "@/lib/api";
import { testAccount, testOutcome } from "@/lib/mail/test-connection";

export const POST = authed<{ id: string }>(async (_req, user, { id }) => {
  const a = await db.mailAccount.findFirst({ where: { id, userId: user.id } });
  if (!a) throw new HttpError("Not found", 404);
  const t = await testAccount(a);
  await db.mailAccount.update({
    where: { id },
    data: testOutcome(t),
  });
  return json(t);
});
