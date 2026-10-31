# VoiceForge UI v2: redesign report

Branch `redesign/ui-v2`, merged into `main` through a pull request. The pre-redesign `main` (commit `5a88d3125ccecfb4d77bbe35ba302a3291ae7000`) is preserved as **`pre-redesign-backup`**. See [Rollback](#6-rollback) for why that is a branch rather than a tag. The plan this followed is in [REDESIGN_PLAN.md](REDESIGN_PLAN.md). Screenshots of every page (light and dark, desktop and phone) are in **[docs/redesign-screenshots/](docs/redesign-screenshots/)**.

**In one line:** VoiceForge now has two sections with real URLs. The **Studio** is for making things and the **Admin** is for running the platform. They share one design system with Light, Dark and System themes. The backend, API, database and routing were not changed.

---

## 1. What changed, page by page

### Everywhere
- **Two sections, two sidebars, one switch.**
  - The Studio (`/studio/...`) has blue accents.
  - The Admin (`/admin/...`) has violet accents and an **Admin** badge next to the logo.
  - A single header button moves between them: **Go to Admin** / **Go to Studio**.
- **Theme switch** (Light / Dark / System) in both headers.
  - The choice is remembered per device (`localStorage` key `vf-theme`).
  - It is applied by a tiny script in `<head>` before the page paints, so there's no flash.
  - Both themes are fully designed. Every colour is a token, so no component has hard-coded white or hex values.
- **Phones:**
  - Below 1024 px the sidebar becomes a slide-over menu (Open menu / Close menu, Escape closes it).
  - Nothing scrolls sideways at 375 px.
- **Shared pieces:**
  - status badges (Online / Offline / Busy / Not verified / Testing… / Done / Running / Queued / Failed);
  - skeleton loaders instead of "Loading…";
  - toasts in both sections (Admin never showed toasts before);
  - real on/off switches;
  - collapsible Details / Advanced sections;
  - copy buttons;
  - tooltips for jargon;
  - a themed confirm dialog that replaces every `window.confirm`.
- **Accessibility:**
  - skip link;
  - `aria-current` on the active page;
  - switches use `role="switch"` and are named by their label;
  - keyboard-operable theme radiogroup;
  - labelled text areas;
  - focus rings;
  - status is never shown by colour alone (always a word, plus a dot).

### Studio
| Page | URL | What's new |
|---|---|---|
| **Home** | `/studio` | Hero, three tool cards that each say whether the tool is **Ready** right now, a 4-step "How it works", and a link to My Library. A plain offline notice appears when no GPU is running. |
| **Text to Speech** | `/studio/speech` | A focused flow: **1 · Your script**, **2 · Voice**, **3 · Generate and listen**. Model and delivery settings are under **Advanced settings**, collapsed. Live progress and time left come from the existing queue. Export sits beside the voice. |
| **Presenter Video** | `/studio/presenter` | The same three numbered steps and one **Generate video** button. Backend names, ids, storage hints and the n8n snippet are shown to the admin only, and the n8n snippet is collapsed. |
| **AI Video** | `/studio/ai-video` | **1 · Describe the scene**, **2 · Shape**, Advanced collapsed, one **Generate clip**. New **"About X min left"** estimate while rendering. Backend and profile facts are admin-only. |
| **My Library** (new) | `/studio/library` | Everything made, newest first: narration, presenter clips and AI clips. Filter tabs, play in place, **Download**, and plain status (Done / Running / Failed). Read-only; deleting stays in Admin → Jobs. |
| **GPU status** | header | The old technical "Speech Live Tesla T4" pill is gone. The studio shows only **GPU Ready / Busy / Offline**, with a tooltip. It re-checks every 30 s while the tab is visible. |

### Admin
| Page | URL | What's new |
|---|---|---|
| **Dashboard** | `/admin` | Shows the active GPU with health and GPU model, plus what serves presenter clips and AI video. Four stat cards: GPU minutes this month, backends online, voices, presenters. Also Recent jobs, the Setup checklist, the public-site warning and 8 quick links. |
| **Backends** | `/admin/backends` | See [section 2](#2-design-decisions-and-why). **Serving now** panel. **How requests are routed** (the real order, plus what Auto means). One card per backend with a status badge, GPU, models, GPU-min this month, last seen, last test result, **Open notebook**, **Test connection**, **Remove** (asks first), real switches (Enabled, Voice, Presenter, AI video) and collapsible **Details**. Setup cards for backends that aren't connected, with copy buttons. **Saved preferences** for pin and priority, with labelled Move up / Move down. |
| **Voices** | `/admin/voices` | New theme, skeletons, and a confirm dialog on delete. Same features. |
| **Presenters** | `/admin/presenters` | New theme, skeletons, and a confirm dialog on delete. Same features. |
| **Training data** | `/admin/training` | New theme, skeletons, and a confirm dialog on delete. Same features. |
| **API Keys** | `/admin/keys` | New theme, skeletons, and a confirm dialog on revoke. Same features. |
| **Jobs** | `/admin/jobs` | Plain kind labels (Narration / Presenter clip / AI video clip). Status filters with counts (All / In progress / Done / Failed). Progress bars. AI-clip and presenter **video previews**, which the old page couldn't show. Copyable ids, plain facts, errors in a readable box, and a confirm dialog on delete. Fixed the wrong "refreshes every 10 seconds" text (it was 30 s). |
| **API & n8n**, **Settings** | `/admin/api`, `/admin/settings` | New shell and theme. Content unchanged. |
| **Login** | `/login` | Themed. Signing in now lands on `/studio`. |

---

## 2. Design decisions and why

1. **Being honest about routing (Backends).**
   - The old page had an "Active backend" picker and priority arrows that looked like they controlled routing. They don't.
   - The routing code (`usableBackends()` / `resolveBackend()`) always uses the fixed order **Colab → Kaggle → Custom → Modal**, picking the first healthy backend that has the feature switched on. The stored `active` and `priority` values are never read.
   - The hard rules say not to change routing, so the page now:
     - **explains the real order**;
     - says what **Auto** means in one sentence: *"Auto means every request goes to the first backend in this order that is online and has that feature switched on."*, followed by *"Free GPUs come first; Modal (paid) is only used when the others can't take the job."*;
     - keeps both old controls, still saving exactly as before, inside a collapsed **"Saved preferences (don't change routing)"** section.
   - `lib/routingView.ts` mirrors the routing rules for display, and a unit test checks it against the server's own functions so the two can't drift apart.
2. **Arrows rather than drag-and-drop for priority.** The brief allowed either. Because priority doesn't affect routing, a prominent drag interface would have advertised a control that does nothing. The labelled **Move up / Move down** buttons are accessible and send the exact requests the old arrows sent.
3. **Who counts as "admin".**
   - VoiceForge has **one account** (the `ADMIN_PASSWORD` login) and no roles, so no role system was invented.
   - The studio layout decides on the server whether the viewer is the admin, by reusing the existing session-cookie check: `!isAuthConfigured() || verifySessionToken(cookie)`.
   - When login is switched on, the studio is already behind it (middleware), so in practice every studio viewer is the admin and sees **Go to Admin**.
   - When login is not configured, the whole site is open, so the switch is shown.
   - The studio's admin-only details (backend names, ids, links into Admin) are gated on the same flag, and a unit test proves a non-admin render contains no `/admin` link.
   - **Security is unchanged:** it stays in `middleware.ts`, and the e2e tests confirm a signed-out visitor is sent to `/login` from every studio and admin URL and that `/api/admin/*` returns 401.
4. **My Library uses the existing jobs endpoint.** No new API was allowed. The studio sits behind the same login as Admin, so My Library reads `GET /api/admin/jobs` (the same call Admin → Jobs makes). It is read-only on purpose.
5. **Old URLs.** The old studio was tabs on `/`, with no per-tool URLs. `/` now redirects to `/studio`, and short paths (`/speech`, `/presenter`, `/ai-video`, `/library`, `/studio/home`, `/studio/video`, `/studio/clips`) redirect to the new pages. All `/admin/*` URLs and `/login` are unchanged. The redirects are temporary (307) so they can be changed later without browsers caching them.
6. **Brand kept.** Same VoiceForge name, same gradient logo badge, and the same blue (`#2563eb`) and violet (`#7c3aed`) brand colours. In dark mode the brand colours shift lighter for contrast.
7. **Theme tokens instead of `dark:` classes.** Colours are CSS variables (RGB triples) that Tailwind reads. Components use names like `bg-surface` or `text-muted`, so one set of classes works in both themes, and future pages get dark mode for free.
8. **"Live" amber stays reserved.** As before, amber means something is running or recording. Warnings in Admin use it sparingly, and it is never used for buttons.
9. **No new dependencies at runtime.** No UI library was added; icons stay hand-written SVG. Dev-only additions: `eslint` + `eslint-config-next` + `@eslint/eslintrc` (the repo had no linter) and `@playwright/test` (pinned to the preinstalled browser's version).
10. **PR #6 is included.** The redesign branch was built on top of [bijaybista006-art/voiceforge#6](https://github.com/bijaybista006-art/voiceforge/pull/6) (Settings → Notebooks, "Open my Colab/Kaggle notebook"). You had approved building it, and the new Backends page shows those buttons. Merging the redesign therefore also merges #6. Its API change is additive: two new optional settings fields, `colabNotebookUrl` and `googleAccount`. Apart from #6, the redesign made only two non-UI code changes:
    - `lib/store.ts` keeps the `health` value it already receives (one line), so the studio can say **Busy**;
    - a `let` in `lib/server/jobs.ts` became `const` (the linter required it; same behaviour).
11. **Removed components.**
    - `components/Shell.tsx` and `components/Connections.tsx` (the old single-page shell and the technical GPU pill) were replaced by `AppShell`, `StudioShell`, `AdminShell` and `GpuStatus`.
    - Every action they offered still exists. "Connect / check again" is now **Check again** on the offline notice, and the background re-check still runs.

---

## 3. Test results

All results below are from the final build on this branch. CI re-runs them on the pull request via the new `.github/workflows/test-frontend.yml`.

| Check | Command | Result |
|---|---|---|
| Install | `npm ci` | ✅ lockfile in sync (no existing dependency version changed) |
| Lint | `npm run lint -- --max-warnings 0` | ✅ 0 errors, 0 warnings |
| Type-check | `npm run typecheck` | ✅ 0 errors |
| Build | `npm run build` | ✅ |
| Unit tests (existing + new) | `npm test` | ✅ **360 passed** (340 existing + 20 new) |
| Backend tests (untouched code) | `python -m pytest backend/tests` | ✅ **210 passed** |
| End-to-end | `npm run test:e2e` | ✅ **85 passed** |
| Screenshots | `SCREENSHOTS=1 npx playwright test e2e/screenshots.spec.ts` | ✅ 60 captured, no console errors on any |

**What the end-to-end suite covers** (`e2e/*.spec.ts`). It runs against a production build; every `/api` call is mocked from `e2e/fixtures.json`, so no database or GPU is needed.
- **pages:** all 14 Studio and Admin pages plus Login load with status 200, show their heading and log **zero console errors**. The GPU pill only says Ready / Busy / Offline and never shows the GPU model. The offline notice appears when there is no GPU.
- **navigation:**
  - all 8 old URLs redirect correctly;
  - admin URLs are unchanged;
  - the one switch goes Studio ↔ Admin;
  - the studio sidebar lists only the 5 studio tools;
  - with login switched on (a second server): a signed-out visitor is sent to `/login` from studio and admin pages, with no admin links visible; `/api/admin/backends` returns 401; signing in lands on `/studio` with **Go to Admin**.
- **theme:**
  - defaults to System and follows the OS live;
  - Dark persists across reloads and across sections, and the background really changes;
  - Light overrides a dark OS;
  - the saved theme is already on `<html>` at DOMContentLoaded (no flash);
  - arrow keys work.
- **layout:** every page at **375 px** and **1440 px** has no sideways scroll. The phone menu opens, closes with Escape and navigates, and the admin menu lists every admin page. The sidebar is visible on desktop.
- **backends**, checking the **exact request body for every control**, compared with the old page:
  - Enabled `{provider, enabled}`;
  - Voice / Presenter / AI video `{provider, voiceEnabled|videoEnabled|clipsEnabled}`;
  - Test connection `POST /test {provider}`;
  - Remove: Cancel sends nothing, Confirm sends `DELETE ?provider=`;
  - Add Custom `{provider, url}`;
  - Pin `{active}`;
  - Move up: two `{provider, priority}` writes, renumbered from 0 as before;
  - also: Details expand/collapse, copy buttons, the Open notebook link, the Serving-now panel and the routing explainer.
- **forms**, checking the same requests as before:
  - Text to Speech: `POST /api/gateway/generate` with `text, voiceId, model, seed` (only known fields);
  - Presenter Video: `POST /api/admin/presenter-clips` with exactly `{text, voiceId, presenterId}`, then it polls the job;
  - AI Video: `POST /api/gateway/clips` with exactly `{prompt, aspect, numFrames: 121, steps: 50, guidance: 5}` by default; Shorts / 720p / negative prompt / seed are sent when set;
  - My Library only reads.

**New unit tests:**
- `lib/__tests__/uiHelpers.test.ts`: the theme boot script, run as real JavaScript against stored and OS values; job labels, lengths and times.
- `components/__tests__/studio.test.tsx`: a server render of the studio as a **non-admin** has no `/admin` link and no switch, but has all 5 tools; as admin it has the switch. Also the offline notice for both, GPU Ready/Busy/Offline, and the AI-video time-left estimate.
- `lib/__tests__/routingView.test.ts`: the display mirror agrees with the server's routing functions.

### Old vs new API usage
Every client-side `fetch` in `components/`, `app/` (pages) and `lib/` (browser code) was listed on `main` and on this branch, normalised to *method + path*:

| | Before (`main`) | After (`redesign/ui-v2`) |
|---|---|---|
| Distinct method + endpoint pairs | 30 | 30 |
| Differences | — | **none** |

The 30 pairs:
- **Backends:** GET/PATCH/DELETE `/api/admin/backends`, POST `/api/admin/backends/test`.
- **Voices:** GET/POST `/api/admin/voices`, DELETE `/api/admin/voices/:id`.
- **Presenters:** GET/POST `/api/admin/presenters`, PATCH/DELETE `/api/admin/presenters/:id`.
- **Training:** GET `/api/admin/training?…`, POST `/api/admin/training`, PATCH/DELETE `/api/admin/training/:id`.
- **Keys:** GET/POST `/api/admin/keys`, DELETE `/api/admin/keys?id=`.
- **Jobs:** GET `/api/admin/jobs`, DELETE `/api/admin/jobs?id=`.
- **Presenter clips:** POST `/api/admin/presenter-clips`, GET `/api/admin/presenter-clips/:id`.
- **Settings:** PUT `/api/admin/settings`.
- **Session:** POST/DELETE `/api/admin/session`.
- **Gateway:** GET `/api/gateway/status`, POST `/api/gateway/generate`, GET/POST `/api/gateway/clips`, GET `/api/gateway/clips/:id`.

Request-building code is byte-for-byte unchanged:
- `lib/gateway.ts`, `lib/clipClient.ts`, `lib/presenterClient.ts`, `lib/directUpload.ts`;
- `generate()` in VideoView and `startClip({...})` in ClipView;
- every Backends request body.

The only new *use* of an existing endpoint is that **My Library** calls `GET /api/admin/jobs` from the studio. Server routes (`app/api/**`), `lib/server/**`, `middleware.ts`, `backend/`, `modal/` and `supabase/` have no redesign changes beyond the `let`→`const` noted above. PR #6's earlier additive settings fields are noted in decision 10.

---

## 4. Checklist: every existing feature is still reachable

**Studio: Text to Speech** (`/studio/speech`)
- [x] Paste a script, or drop a .txt/.md file; show normalized text; word, chunk and duration counts
- [x] Chunk list: Generate all / Generate remaining / Regenerate all; Pause / Resume / Stop; per-chunk play, regenerate and edit; progress and time left
- [x] Saved after every chunk (IndexedDB); leave-page warning while generating
- [x] Voice library: choose a voice, play a sample, delete (now with a confirm dialog)
- [x] Add a voice: record or upload, name, transcript, trim silence
- [x] Model, language, expressiveness, adherence, variation, seed (randomize), delivery style, A/B compare: under **Advanced settings**
- [x] Export: paragraph and sentence gaps; audio, subtitles and zip downloads

**Studio: Presenter Video** (`/studio/presenter`)
- [x] Script, voice, presenter choice with readiness, Generate, stage progress, result video, download, link, lip-sync score; resume the last clip after a reload; n8n snippet (admin, collapsed)

**Studio: AI Video** (`/studio/ai-video`)
- [x] Prompt and example prompts, 16:9 / 9:16, quality, length, negative prompt, steps, guidance, seed; Generate; progress (plus the new time left); result, download, **Reuse settings**; resume after a reload; n8n snippet (admin, collapsed)

**Studio: other**
- [x] Home with links to every tool, and the GPU status (now Ready / Busy / Offline)
- [x] Re-check the GPU (automatic every 30 s, plus **Check again**)
- [x] *New:* My Library

**Admin**
- [x] Dashboard: setup checklist and the public-site warning (kept); serving GPU, stats, recent jobs and quick links (new)
- [x] Backends:
  - routing status;
  - per-backend enable, plus Voice / Presenter / AI video switches;
  - Test connection;
  - Remove (now confirmed);
  - add Modal / Custom by URL;
  - Colab / Kaggle connect snippets with app URL and token;
  - Open my notebook / fresh-copy links;
  - restart guide;
  - Active pin and priority (under Saved preferences);
  - GPU-minutes usage;
  - details (addresses, version, capabilities, notes)
- [x] Voices: add (record or upload), rename, sync to the active backend, set default, change language, linked voices, copy voice id, play, delete (confirmed)
- [x] Presenters: readiness per kind, add (recording or image, consent), set default, copy id, preview, delete (confirmed)
- [x] Training data: speakers, languages, record or upload with transcript and notes, edit, play, delete (confirmed), "use these recordings as a voice", summary
- [x] API Keys: create (shown once) with rate limits, list, revoke (confirmed)
- [x] Jobs: list, play, download, see errors, delete (confirmed), auto-refresh; *new:* filters, video previews, copy id
- [x] API & n8n: every snippet with the deployment's URL
- [x] Settings: retention, default model and language, Nepali model, speed and ending, pronunciations, notebooks (from PR #6)
- [x] Sign out (Admin sidebar footer, when login is configured)
- [x] Login page

**Platform**
- [x] All `/admin/*` URLs and `/login` unchanged; `/` and short paths redirect
- [x] `/api/v1/*` (n8n), `/api/backends/register`, `/api/internal/*`: untouched
- [x] Login gate (`middleware.ts`): untouched; stays open until both env vars are set

---

## 5. What couldn't be done, or was done differently

- **Drag-and-drop priority:** labelled Move up / Move down buttons were used instead (decision 2). Priority does not affect routing, and changing routing was out of scope.
- **Separate "user" and "admin" accounts:** VoiceForge has one login and no roles, and inventing a role system was explicitly out of scope (decision 3). Admin details in the studio are hidden for non-admins, but with login switched on, everyone who can reach the studio *is* the admin.
- **ETA:**
  - Text to Speech shows time left from the queue's measured average.
  - AI Video shows "About X min left" once enough progress has been reported.
  - **Presenter Video has no reliable progress percentage** from the backend (only stages), so it shows the current stage rather than inventing a time.
- **Screenshots** use the same mocked data as the tests. The Admin Dashboard is rendered on the server, where there is no database in the test setup, so its screenshots show the "nothing set up yet" state. The Backends page shows the populated state.
- **Settings and API & n8n** got the new shell and theme, but their content and layout were kept as they were: they are long reference or forms pages that already worked, and restructuring them risked breaking saves.
- **Visual-regression baselines** (pixel diffs) were not added. The screenshots are documentation, not assertions.

---

## 6. Rollback

**The backup.** The pre-redesign `main` is commit **`5a88d3125ccecfb4d77bbe35ba302a3291ae7000`** (the merge of PR #5).
- The brief asked for a tag `pre-redesign-backup`. The tag was created, but this environment's git connection silently drops tag pushes: `git push` reported "Everything up-to-date" four times and the tag never reached GitHub. None of the available GitHub tools can create a tag either.
- So the backup was pushed as a **branch with the same name, `pre-redesign-backup`**, pointing at exactly that commit. Branches are pushed normally, so it is safely on GitHub. Don't delete it.

To also make it a real tag (one-off, from your own machine):

```bash
git fetch origin pre-redesign-backup
git tag -a pre-redesign-backup-tag 5a88d3125ccecfb4d77bbe35ba302a3291ae7000 -m "main before UI v2"
git push origin pre-redesign-backup-tag
```

(The tag gets a different name so `pre-redesign-backup` doesn't refer to both a branch and a tag.)

Every command below uses the commit SHA, so it works whether or not the tag exists.

**Option A: revert the merge (recommended; keeps history and is safe for Vercel).** This finds the redesign's merge commit on `main` and reverts it:

```bash
git checkout main
git pull origin main
MERGE=$(git log --merges --format=%H --grep="redesign/ui-v2" -1 origin/main)
git revert -m 1 "$MERGE"
git push origin main
```

Vercel redeploys `main` automatically. To bring the redesign back later, revert that revert commit.

**Option B: reset `main` to the backup (rewrites history).** Use this only if A is not possible. It also removes anything merged after the redesign, including PR #6's notebook settings, which came in with it.

```bash
git checkout main
git fetch origin
git reset --hard 5a88d3125ccecfb4d77bbe35ba302a3291ae7000
git push --force-with-lease origin main
```

**Option C: roll back only the live site, without touching git.** In Vercel → Project → Deployments, open the last deployment from before the merge and choose **Promote to Production** (or **Instant Rollback**).
