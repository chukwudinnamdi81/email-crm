import type { Metadata } from "next";
import LegalLayout from "@/components/legal/LegalLayout";
import { contactText, legal } from "@/lib/legal";
import { STORAGE_ENTRIES, TRACKERS } from "@/lib/storage-registry";

export const metadata: Metadata = { title: "Privacy Policy | Mail CRM", description: "How Mail CRM collects, uses and protects your data." };
export const dynamic = "force-dynamic";

const SECTIONS = [
  { id: "collect", title: "What we collect" },
  { id: "use", title: "How we use it" },
  { id: "sharing", title: "Who we share it with" },
  { id: "ai", title: "AI features" },
  { id: "cookies", title: "Cookies and browser storage" },
  { id: "security", title: "Security" },
  { id: "rights", title: "Your rights and deleting data" },
  { id: "retention", title: "Retention" },
  { id: "children", title: "Children" },
  { id: "changes", title: "Changes" },
  { id: "contact", title: "Contact" },
];

export default function Privacy() {
  const noTracking = TRACKERS.length === 0 && STORAGE_ENTRIES.every((e) => e.essential);
  return (
    <LegalLayout title="Privacy Policy" sections={SECTIONS}>
      <p>This policy describes how {legal.entity()} (&ldquo;we&rdquo;) handles personal data in the Mail CRM service.</p>
      <section id="collect">
        <h2>What we collect</h2>
        <ul>
          <li>Account: your email address and a hash of your password (we never store the password itself).</li>
          <li>If you sign in with Google: your Google account id and email address. We request only the &ldquo;openid email&rdquo; scopes and do not store Google tokens for sign-in.</li>
          <li>Connected mailboxes and senders: credentials or access tokens, stored encrypted.</li>
          <li>Mail you sync and the contacts derived from it, plus your sequences, auto-responder settings and business profile.</li>
          <li>AI usage counts, used to apply daily limits.</li>
        </ul>
      </section>
      <section id="use">
        <h2>How we use it</h2>
        <p>To provide the service: sign you in, sync and display your mail, run the sequences and auto-responders you configure, and send you account emails (confirmation codes, password resets, notices).</p>
      </section>
      <section id="sharing">
        <h2>Who we share it with</h2>
        <p>Only service providers needed to run the features you use:</p>
        <ul>
          <li>Your own mail providers (the mailboxes and SMTP senders you connect).</li>
          <li>The AI provider configured by you or by the server administrator.</li>
          <li>The site email provider that sends confirmation, reset and notice emails.</li>
          <li>Google, when you use Google sign-in or connect a Google mailbox.</li>
        </ul>
      </section>
      <section id="ai">
        <h2>AI features</h2>
        <p>When you use AI features, the following may be sent to the configured AI provider: recent messages in the relevant email thread (sender address, date, subject and the start of the message text), the subject and text of the message being classified or answered, drafts you ask it to rewrite, and your business profile settings (such as tone and signature).</p>
      </section>
      <section id="cookies">
        {/* Rendered from lib/storage-registry.ts. Add new cookies / storage keys / trackers there. */}
        <h2>Cookies and browser storage</h2>
        <ul>
          {STORAGE_ENTRIES.map((e) => (
            <li key={`${e.kind}:${e.name}`}>
              <strong><code>{e.name}</code></strong> ({e.kind === "cookie" ? "cookie" : "browser storage"}{e.httpOnly ? ", not readable by page scripts" : ""}): {e.purpose} Lasts: {e.duration}. {e.essential ? "Essential." : "Not essential."}
              {e.condition ? ` ${e.condition}` : ""}
            </li>
          ))}
        </ul>
        {TRACKERS.length > 0 && (
          <>
            <h3>Third-party services</h3>
            <ul>{TRACKERS.map((t) => <li key={t.name}><strong>{t.name}</strong> ({t.provider}): {t.collects} Opt out: {t.optOut}</li>)}</ul>
          </>
        )}
        {noTracking && <p>We do not use analytics, advertising or tracking cookies.</p>}
      </section>
      <section id="security">
        <h2>Security</h2>
        <p>Mailbox passwords, tokens, sender credentials and API keys are encrypted at rest. Account passwords are stored as hashes. Email confirmation codes are stored only as keyed hashes and expire after 15 minutes. Sign-in, sign-up and email sending are rate limited. No system is perfectly secure.</p>
      </section>
      <section id="rights">
        <h2>Your rights and deleting data</h2>
        <p>You can ask us to access, correct or delete your data. You can download your data and delete synced mail or your whole account yourself under Settings &rarr; Account &amp; data; for anything else, contact us at {contactText()}.</p>
      </section>
      <section id="retention">
        <h2>Retention</h2>
        <p>Your data is kept until you delete it or ask us to delete it. When you delete your account, your data is deleted immediately from our database; copies in backups age out according to our backup policy. Accounts that never confirm their email address are removed automatically after a few days.</p>
      </section>
      <section id="children"><h2>Children</h2><p>The service is not intended for children under 16.</p></section>
      <section id="changes"><h2>Changes</h2><p>We may update this policy; the date above shows the latest version.</p></section>
      <section id="contact"><h2>Contact</h2><p>Questions: {contactText()}.</p></section>
    </LegalLayout>
  );
}
