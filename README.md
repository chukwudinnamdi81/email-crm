# Mail CRM

Next.js (App Router) + Postgres (Prisma) + Redis + a separate BullMQ worker (`worker/index.ts`).

## Local

```
cp .env.example .env   # set ENCRYPTION_KEY (openssl rand -base64 32), SIGNING_SECRET
npm install && npx prisma db push
npm run db:backfill    # one-time: marks existing users as email-confirmed (safe to re-run)
npm run dev            # web
npm run worker         # worker (separate terminal)
```

## Docker

One image, two roles chosen by `SERVICE`:

```
docker build -t mailcrm .
docker run -e SERVICE=web    ... mailcrm     # runs `prisma db push`, then Next.js on $PORT
docker run -e SERVICE=worker ... mailcrm     # BullMQ worker
```

Health check: `GET /api/health` (checks Postgres and Redis).

## Deploy notes (create: web service, worker service, Postgres, Redis; share the same env vars on both services)

**Railway** – add Postgres and Redis plugins; create two services from this repo (Dockerfile). Web: `SERVICE=web`, health check `/api/health`. Worker: `SERVICE=worker`. Reference `DATABASE_URL` / `REDIS_URL` from the plugins.

**Render** – create a Postgres and a Key Value (Redis) instance; one *Web Service* (Docker, `SERVICE=web`, health path `/api/health`) and one *Background Worker* (Docker, `SERVICE=worker`).

**Fly.io** – `fly postgres create`, Upstash Redis (`fly redis create`); one app with two process groups in `fly.toml`:
`[processes] web = "sh -c 'SERVICE=web ...'"`, `worker = "sh -c 'SERVICE=worker ...'"` (or two apps with different `SERVICE`). Set secrets with `fly secrets set`.

Required env: `DATABASE_URL`, `REDIS_URL`, `ENCRYPTION_KEY`, `SIGNING_SECRET`, `APP_URL`. See `.env.example` for the rest.

### Deploying on Railway

- Web service: `SERVICE=web`; worker service: `SERVICE=worker`.
- `DATABASE_URL` and `REDIS_URL`: reference them from the Postgres and Redis plugins (an unset `REDIS_URL` falls back to localhost and logs a warning).
- `APP_URL`: the public `https://` URL of the web service.
- Site email: `SITE_MAIL_PROVIDERS=resend`, `SITE_RESEND_API_KEY`, and `SITE_MAIL_FROM` on a domain verified in Resend. Outbound SMTP may be blocked on Railway, so prefer Resend/Postmark.
- Check `/api/health` after deploy, and look for a `[config]` warning in the web logs listing anything missing.

**Port 25 warning:** email verification (SMTP handshake) needs outbound port 25, which Railway/Render/Fly commonly block. The Contacts page shows a warning when the worker's self-test fails.

## Security notes

Mailbox passwords, OAuth tokens, SMTP passwords and user AI keys are encrypted with AES-256-GCM (`lib/crypto.ts`) and never returned to the client (masked). Everything is scoped by `userId` server-side.

## Site emails, sign-up and sign-in

New accounts confirm their email with a 6-digit code (15 min, 5 tries). Set the `SITE_*` variables from `.env.example` on the **web** service (the worker doesn't send site emails); a transactional provider such as Resend works over HTTPS and needs no ports. Site emails never go through users' own mailboxes/senders. Google sign-in reuses `GOOGLE_CLIENT_ID/SECRET` and needs `${APP_URL}/api/auth/google/callback` as an extra authorized redirect URI. The worker removes unconfirmed accounts after `SITE_UNVERIFIED_TTL_DAYS` (default 7) once a day.

Emergency brake: `SIGNUPS_ENABLED=false` closes sign-ups (password and new Google accounts); existing users keep working. `SIGNUP_MAX_PER_HOUR` / `SIGNUP_MAX_PER_DAY` cap new accounts globally.

Legal pages (`/privacy`, `/terms`) read `LEGAL_ENTITY_NAME`, `LEGAL_CONTACT_EMAIL`, `LEGAL_EFFECTIVE_DATE`, `LEGAL_GOVERNING_LAW`. Have the text reviewed by a lawyer.

### Adding a cookie, browser storage key or analytics tool

Add the entry to `lib/storage-registry.ts` first; the privacy page updates itself, and `npm run check:storage` (run before every build) fails if you missed one.

## Deploying this update

1. Set the site email variables and `APP_URL` on the web service.
2. In Google Cloud Console add `${APP_URL}/api/auth/google/callback` as an authorized redirect URI and publish the consent screen from "Testing" to "In production".
3. Deploy. The web container runs `db push` then the one-time backfill (look for `grandfathered N users` in its logs; if it fails the container won't start, which is intended).
4. Log in as yourself to confirm you were grandfathered.
5. Fill the `LEGAL_*` variables and have the privacy and terms pages reviewed by a lawyer.
6. Emergency brakes: `SIGNUPS_ENABLED=false` and `STORAGE_CHECK=warn` (lets a hotfix build pass with a loud banner; never the default).

## Sync tuning

- `SYNC_CONCURRENCY` (default 3): jobs the worker runs at once. `SYNC_INTERVAL_MINUTES` (default 10): scheduled incremental sync.
- `SYNC_PER_USER_CONCURRENCY` (default 2): mailboxes of one user syncing at once (Redis lease; a crashed worker frees its slot within 2 minutes).
- `SYNC_SLICE_SECONDS` (default 240): a long backfill pauses after this long, only when other jobs are waiting, and resumes where it stopped.
- `SYNC_MAX_FULL_SYNC_MESSAGES` (default 0 = off): refuse a first sync of everything for a mailbox larger than this.
- The worker writes a `worker:heartbeat` Redis key every 15s; `/api/health` and the Sync page use it to tell whether the worker is running.
- Schema changes in this release (new columns on MailAccount, Folder, SyncJob) are applied with `npm run prisma:migrate` (`prisma db push`).
- `npm test` runs the unit tests.
