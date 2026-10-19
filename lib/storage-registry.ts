// Single source of truth for cookies / browser storage / third-party trackers.
// The privacy page renders from this file and `npm run check:storage` (run before every build)
// fails when the code uses something that is not listed here. Purposes and durations are written by a person.

export type StorageEntry = {
  kind: "cookie" | "localStorage" | "sessionStorage";
  name: string;
  purpose: string;
  duration: string;
  essential: boolean;
  httpOnly?: boolean;
  setIn: string; // repo-relative file where it is set
  condition?: string;
};

export type TrackerEntry = {
  name: string;
  provider: string;
  collects: string;
  optOut: string;
  match: string[]; // package names, script hostnames or global names the guard looks for
};

/** Manual field: update when you last re-checked this list. */
export const STORAGE_REGISTRY_REVIEWED = "2026-10-19";

export const STORAGE_ENTRIES: StorageEntry[] = [
  {
    kind: "cookie",
    name: "session",
    purpose: "Keeps you signed in. Holds a random sign-in token (only its hash is stored on our server). Set when you sign in and deleted when you log out.",
    duration: "30 days",
    essential: true,
    httpOnly: true,
    setIn: "lib/auth.ts",
  },
  {
    kind: "cookie",
    name: "g_nonce",
    purpose: "Protects 'Continue with Google' against forged sign-in requests by tying the request to your browser.",
    duration: "10 minutes",
    essential: true,
    httpOnly: true,
    setIn: "app/api/auth/google/start/route.ts",
    condition: "Only set when you click 'Continue with Google' (and Google sign-in is configured).",
  },
  {
    kind: "localStorage",
    name: "theme",
    purpose: "Remembers your Light / Dark / System appearance choice. Never sent to our server.",
    duration: "Until you clear your browser data",
    essential: true,
    setIn: "components/ThemeToggle.tsx",
    condition: "Only written when you pick a theme.",
  },
  {
    kind: "localStorage",
    name: "onboarding:dismissed",
    purpose: "Remembers that you dismissed the 'Get started' checklist on the dashboard so it stays hidden. Never sent to our server.",
    duration: "Until you clear your browser data",
    essential: true,
    setIn: "app/(app)/dashboard/page.tsx",
    condition: "Only written when you click 'Dismiss' on the Get started checklist.",
  },
];

export const TRACKERS: TrackerEntry[] = [];
