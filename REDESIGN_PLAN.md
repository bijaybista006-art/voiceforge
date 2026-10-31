# VoiceForge UI v2: redesign plan

Branch: `redesign/ui-v2` (built on top of `claude/zen-ptolemy-dd4ujr`, i.e. PR #6, so the saved-notebook buttons are carried along instead of being rewritten twice).

## What exists today (explored)

- **Stack:** Next.js 15.5 App Router, React 19, Tailwind 3.4, zustand store, zod. Fonts via `next/font` (Space Grotesk / Inter / JetBrains Mono). Vitest unit tests (`npm test`). No ESLint, no E2E.
- **Routing:** the whole studio is one client page (`app/page.tsx`) that swaps views in React state (Home / Speech / Presenter / AI video). Admin is `app/admin/*` with `AdminShell`.
- **Auth:** one admin password. `middleware.ts` gates every page and `/api/admin` once `ADMIN_PASSWORD` + `SESSION_SECRET` are set; an unconfigured deploy is open. There is no user/role model: anyone who can see the studio is the admin.
- **Deploy:** Vercel builds `main` automatically; `.github/workflows/deploy-modal.yml` redeploys Modal when `backend/**` or `modal/**` change (this redesign touches neither).
- **Routing truth (important for the Backends page):** `usableBackends()` / `resolveBackend()` always use the fixed order Colab → Kaggle → Custom URL → Modal and the first healthy one wins. The "Active backend" picker (`active`) and the up/down priority arrows (`priority`) are stored but no routing code reads them. Backend logic must not change, so the UI will say this plainly and keep both controls reachable as clearly labelled legacy preferences.

## Navigation

### Studio (`/studio/...`): for making things
| Page | Route | Was |
|---|---|---|
| Home | `/studio` | `/` (view "home") |
| Text to Speech | `/studio/speech` | `/` (view "speech") |
| Presenter Video | `/studio/presenter` | `/` (view "video") |
| AI Video | `/studio/ai-video` | `/` (view "clips") |
| My Library | `/studio/library` | new, reads the existing `GET /api/admin/jobs` |

Header: friendly GPU status (Ready / Busy / Offline), theme toggle, and **Go to Admin** (only when the viewer has an admin session, or when login isn't configured, which already makes everyone an admin). No admin links anywhere else in the studio.

### Admin (`/admin/...`): for running the platform
Dashboard, Backends, Voices, Presenters, Training data, API Keys, Jobs, plus the existing API & n8n and Settings pages (kept, so no feature disappears).

Header: **Admin** badge, theme toggle, **Go to Studio**, Sign out. Sidebar uses the violet accent (studio uses blue) so the two sections are distinct.

### Redirects
`/` → `/studio` (the old studio address). Old admin URLs are unchanged. Login's default destination becomes `/studio`.

## Design tokens

All colours become CSS variables (RGB channels) consumed by the existing Tailwind token names (`bg`, `surface`, `surface2`, `surface3`, `line`, `lineStrong`, `ink`, `muted`, `faint`, `audio`, `video`, `live`, `danger`, `ready`, `brand-*`, `accent-*`). Every existing component follows the theme without per-component dark classes.

- Light: slate ground `#f4f6fa`, white surfaces, ink `#0f172a`, muted `#475569`, faint `#64748b` (raised from `#94a3b8` for contrast).
- Dark: designed separately, not inverted. Ground `#090c14`, surfaces `#11151f` / `#161b27` / `#1e2432`, ink `#e6ebf3`, lighter brand blue `#60a5fa` and violet `#a78bfa` for text on dark.
- Status: ready (green), live/working (amber, only while generating), danger (red), each tuned per theme.
- Radius 12/16 px, soft shadows (darker in dark mode), Space Grotesk headings, Inter body, JetBrains Mono for technical values.

### Theme
Light / Dark / System toggle in both headers. Choice saved in `localStorage` (`vf-theme`). An inline script in `<head>` sets `data-theme` before the first paint (no flash). A `prefers-color-scheme` CSS fallback covers no-JS.

## Shared components (`components/ui/`)
Existing, restyled: Button, Card/CardHeader/EmptyState, Badge, Input/Textarea, Select, Dialog, Toast, ProgressBar.
New: `ThemeToggle`, `Toggle` (switch), `ConfirmDialog` + `useConfirm` (replaces every `window.confirm`), `StatusBadge`, `Skeleton`, `Tooltip`, `Disclosure` (Advanced / Details sections), `CopyButton`, `PageHeader`.

## Page work, in order
1. **Backends:** "Serving now" card (the backend requests go to, from the same rule as the server) + health; the real routing order explained in one sentence; backend cards with status badges, GPU, models, usage, real toggle switches (Enabled, Voice, Presenter, AI video), Test connection / Remove buttons (Remove asks for confirmation), a collapsible Details section (URLs, heartbeat, errors), and empty-state setup cards for anything not connected; legacy preference (pin + priority arrows) in a labelled collapsible.
2. **Dashboard:** serving GPU + health, recent jobs, GPU minutes this month, voice and presenter counts, quick links, setup checklist.
3. **Studio:** Home, Text to Speech, Presenter Video, AI Video as focused tools (input, Advanced collapsed, one Generate button, live progress + ETA where the data allows, result with preview and download), My Library.
4. Voices, Presenters, Training data, API Keys, Jobs (and API & n8n, Settings): token restyle, shared components, confirm dialogs.

## Testing
ESLint (`eslint-config-next`), `tsc`, `next build`, Vitest, Python tests untouched, Playwright E2E (`e2e/`) against `next start` with mocked `/api/**`, screenshots to `docs/redesign-screenshots/`.
