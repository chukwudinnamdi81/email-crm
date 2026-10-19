"use client";
import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import LogoutButton from "./LogoutButton";
import ThemeToggle from "./ThemeToggle";
import SyncStatusPill from "./SyncStatusPill";

const ICONS = {
  home: "M3 11 12 3l9 8M5 10v10h14V10",
  mail: "M3 5h18v14H3zM3 7l9 6 9-6",
  users: "M16 11a4 4 0 1 0-8 0M4 20a8 8 0 0 1 16 0",
  send: "m22 2-7 20-4-9-9-4zM22 2 11 13",
  reply: "M9 14 4 9l5-5M4 9h10a6 6 0 0 1 6 6v3",
  plug: "M9 2v6m6-6v6M6 8h12v4a6 6 0 0 1-12 0zM12 18v4",
  server: "M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01",
  sync: "M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M21 4v5h-5M3 20v-5h5",
  spark: "M12 3l2.1 5.9L20 11l-5.9 2.1L12 19l-2.1-5.9L4 11l5.9-2.1z",
  brief: "M3 7h18v13H3zM9 7V4h6v3",
} as const;
type Icon = keyof typeof ICONS;

const SECTIONS: { title: string; items: [string, string, Icon][] }[] = [
  { title: "Overview", items: [["/dashboard", "Dashboard", "home"]] },
  { title: "Mail", items: [["/mail", "Mail", "mail"], ["/contacts", "Contacts", "users"]] },
  { title: "Outreach", items: [["/sequences", "Sequences", "send"], ["/auto-responders", "Auto-responders", "reply"]] },
  { title: "Connections", items: [["/accounts", "Mail accounts", "plug"], ["/senders", "SMTP senders", "server"], ["/sync", "Sync", "sync"]] },
  { title: "Settings", items: [["/settings/ai", "AI settings", "spark"], ["/settings/profile", "Business profile", "brief"]] },
];

const Svg = ({ d }: { d: string }) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
);

function Brand() {
  return (
    <a href="/dashboard" className="flex items-center gap-2 font-semibold text-fg no-underline hover:no-underline">
      <span className="grid size-8 place-items-center rounded-lg bg-brand text-inverse" aria-hidden="true"><Svg d={ICONS.mail} /></span>
      Mail CRM
    </a>
  );
}

function Panel({ email, path }: { email: string; path: string }) {
  return (
    <div className="flex h-full flex-col">
      <div className="px-4 py-4"><Brand /></div>
      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pb-4">
        {SECTIONS.map((s) => (
          <div key={s.title} className="mb-4">
            <div className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{s.title}</div>
            {s.items.map(([href, label, icon]) => {
              const active = path === href || path.startsWith(href + "/");
              return (
                <a
                  key={href} href={href} aria-current={active ? "page" : undefined}
                  className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm no-underline hover:no-underline ${active ? "bg-brand-soft font-medium text-link" : "text-fg hover:bg-surface-muted"}`}
                >
                  <Svg d={ICONS[icon]} />{label}
                </a>
              );
            })}
          </div>
        ))}
      </nav>
      <div className="space-y-3 border-t border-line p-4">
        <SyncStatusPill />
        <div className="truncate text-sm text-muted" title={email}>{email}</div>
        <div className="flex flex-wrap items-center gap-2"><LogoutButton /><ThemeToggle /></div>
        <div className="flex gap-3 text-xs"><a href="/">Home page</a><a href="/privacy">Privacy</a><a href="/terms">Terms</a></div>
      </div>
    </div>
  );
}

export default function AppNav({ email }: { email: string }) {
  const path = usePathname();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", onKey); document.body.style.overflow = ""; };
  }, [open]);

  return (
    <>
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-64 border-r border-line bg-surface lg:block"><Panel email={email} path={path} /></aside>
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-line bg-surface px-4 py-2.5 lg:hidden">
        <Brand />
        <SyncStatusPill compact />
        <button type="button" className="btn btn-secondary !px-2.5" aria-label="Open menu" aria-expanded={open} aria-controls="app-drawer" onClick={() => setOpen(true)}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16" /></svg>
        </button>
      </header>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden="true" />
          <div id="app-drawer" role="dialog" aria-modal="true" aria-label="Menu" className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-surface shadow-lifted">
            <button type="button" className="btn btn-ghost absolute right-2 top-2 !px-2" aria-label="Close menu" autoFocus onClick={() => setOpen(false)}>✕</button>
            <Panel email={email} path={path} />
          </div>
        </div>
      )}
    </>
  );
}
