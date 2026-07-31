# IOE Admin Portal — Project Documentation

> **Live URL:** https://ioe-admin-portal.vercel.app  
> **GitHub:** https://github.com/sravanthi025/ioe-admin-portal  
> **Owner:** Sravanthi Yerramsetty (NxtWave, Hyderabad)

---

## What This Is

The **Intensive Offline Evaluation (IOE) Admin Portal** is an internal web tool for NxtWave's Intensive Offline program. It centralises the full lifecycle of offline assessments — from student data management and syllabus scheduling through Topin assessment publishing and IC interview coordination — replacing manual coordination via WhatsApp/Excel/email with a role-gated, tracked dashboard.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | Vanilla HTML + CSS + JavaScript (ES modules via CDN, zero build step) |
| Database | Firebase Firestore (project: `ioe-admin-portal`) |
| Auth | Firebase Authentication (email/password + anonymous guest) |
| Hosting | Vercel (static files + serverless functions) |
| Serverless APIs | Vercel functions in `api/` (Node.js, ESM→CJS compiled by Vercel) |
| Admin SDK | Firebase Admin SDK (only inside Vercel functions, for IC Firebase access) |
| Local Automation | Express + Playwright (in `server/`, runs on the user's machine, never deployed) |
| Email alerts | EmailJS (SLA breach notifications) |

**No build tool, no bundler, no framework.** Everything runs directly in the browser as ES modules. Firebase SDK is loaded from `https://www.gstatic.com/firebasejs/10.12.2/`.

---

## File Structure

```
ioe-admin-portal/
├── index.html                  # Complete SPA shell — all screens/modals/pages in one file
├── app.js                      # All frontend logic (~5200 lines, single ES module)
├── styles.css                  # All CSS (CSS variables, utility classes, component styles)
├── firebase-config.js          # Firebase credentials — GITIGNORED, never commit
├── firebase-config.example.js  # Template — copy to firebase-config.js and fill in values
├── logo.png                    # NxtWave Intensive brand logo
├── package.json                # Root package — only lists firebase-admin (used by Vercel functions)
│
├── api/                        # Vercel serverless functions (deployed automatically on git push)
│   ├── invite.js               # POST /api/invite — proxies student invitations to external API
│   ├── ic-interviews.js        # GET /api/ic-interviews — reads interview data from IC Firebase
│   └── ic-request.js           # POST /api/ic-request — writes interview requests to IC Firebase
│
└── server/                     # LOCAL automation server — NOT deployed, runs on user's machine
    ├── index.js                # Express server: OTP login (Playwright) + direct Topin API publish
    ├── topin-client.js         # Token management, tag gen, Topin REST + GraphQL API calls
    ├── seb-template.xml        # SEB browser config XML (uploaded with SEB-mode assessments)
    ├── invite-email-template.html  # HTML email body for student assessment invitations
    ├── package.json            # Server deps: express, cors, playwright
    ├── start.ps1               # PowerShell script to start the local server
    ├── topin-session.json      # Saved Playwright browser session (gitignored)
    └── topin-tokens.json       # Saved IB + Topin OAuth tokens (gitignored)
```

---

## Deployment

### Production Deploy (always required after code changes)
```powershell
# From ioe-admin-portal directory:
git add <files>
git commit -m "message"
git push origin main
vercel --prod          # MUST run this — Vercel auto-deploy is NOT enabled
```

Vercel does not auto-deploy on push. You must run `vercel --prod` manually every time.

### Local Dev (optional — just open index.html in browser)
Since there's no build step, you can open `index.html` directly. But `firebase-config.js` must exist with real credentials, and CORS restrictions mean some API features won't work locally without a dev server.

---

## Environment Variables (set in Vercel dashboard)

| Variable | Used By | Purpose |
|---|---|---|
| `IC_SA_B64` | `api/ic-interviews.js`, `api/ic-request.js` | Base64-encoded Firebase Admin service account JSON for the IC (Interviewer Community) Firebase project |

Set these at: Vercel Dashboard → ioe-admin-portal project → Settings → Environment Variables.

---

## Firebase Setup

### IOE Firebase Project (`ioe-admin-portal`)
- Used for all portal data (students, syllabus, configs, assignments, etc.)
- Credentials live in `firebase-config.js` (gitignored)
- **Auth setting to keep disabled:** "Email enumeration protection" under Firebase Console → Authentication → Settings → User actions. If this is ON, logins hang for 2+ minutes.

### IC Firebase Project (separate)
- Belongs to the IC (Interviewer Community) team
- Accessed only via Vercel serverless functions using a service account (`IC_SA_B64` env var)
- The portal never has direct frontend access to this project
- Collections used: `interviews` (read), `interview_requests` (write)

### Firestore Collections (IOE project)

| Collection | Purpose | Key Fields |
|---|---|---|
| `students` | Student roster | `phase`, `batch`, `week`, `uid`, `student_id`, `name`, `email`, `contact_number`, `assessment_date` |
| `syllabus` | Assessment schedule per week | `phase`, `batch`, `week`, `assessment_date`, `start_time`, `end_time`, `mock_assessment`, `mock_date`, `mock_start_time`, `mock_end_time`, `subjects[]` (each: `name`, `topics`) |
| `topic_configs` | Topin config links per assessment | `phase`, `batch`, `week`, `config_link` (main), `mock_config_link`, `status` (`pending`/`submitted`), `domain`, `submitted_at`, `published_at`, `published_mock_at`, `invite_sent` |
| `assessments` | Published Topin assessments | `phase`, `batch`, `week`, `domain`, `assessment_name`, `config_link`, `assessment_link`, `status`, `invite_sent`, `published_at` |
| `team_members` | Portal user registry & roles | `name`, `email`, `team`, `status` (`pending`/`approved`/`rejected`) |
| `assignments` | Assessment assignment requests | `phase`, `batch`, `week`, `domain`, `subjects[]`, `status`, `links[]`, `alloc[]` (allocated students), `eval{}` (evaluation scores), `requested_by`, `requested_at` |
| `notifications` | In-app notification log | `type`, `status`, `title`, `message`, `targetTeams[]`, `readBy[]`, `createdAt` |
| `settings` | Portal-wide config | `emailjs_service_id`, `emailjs_template_id`, `emailjs_escalation_template`, `emailjs_public_key`, `sla_manager_emails`, `sla_escalate_after_hours` |

---

## User Roles & Access

Users register via the portal and are approved/rejected by Admin. Role is stored in `team_members.team`.

| Role | Nav Access | Key Permissions |
|---|---|---|
| **Admin** | All pages | Full CRUD everywhere, approve/reject team members, delete records, manage SLA settings |
| **Content Team** | Syllabus, Configs, Assignments | Add/edit syllabus, submit Topin config links, edit assignment links |
| **Assessment Ops Team** | Students, Assessments, Assessment Details, Assignments | Upload students, publish assessments, allocate students to assignments, download CSV |
| **Invigilator** | Students, Assignments | Download allocation CSV for on-ground distribution |
| **Instructor** | Assignments | Evaluate students, view/import submission links |
| **Guest** | Read-only everything | No login required — anonymous Firebase auth via "Continue as Guest" |

Role is applied in `applyRoleAccess(team)` in `app.js` which shows/hides nav items and disables action buttons via CSS classes. Guest mode uses `signInAnonymously(auth)` and sets `isGuest = true`.

---

## Pages & Features

### Dashboard (`page-dashboard`)
- Summary cards: total students, syllabus entries, configs (pending/submitted), SLA breach count
- Quick-action links to filtered views (e.g. "5 pending configs" → clicks into Configs page pre-filtered)
- Loaded by `loadDashboard()` via parallel Firestore reads

### Student Data (`page-students`)
Three upload modes (tabs):
1. **CSV Upload** — drag-drop or file-select. Template: `phase, batch, week, uid, student_id, name, email, contact_number, assessment_date`. Previewed before upload, uploaded to `students` collection.
2. **Manual Add** — form with same fields, one student at a time
3. **Fetch from API** — calls external student API with API key + endpoint, previews results, saves to Firestore

Features: filter by phase/batch/week/date range/search, paginated table (15/page), export to CSV, delete.

### Syllabus (`page-syllabus`)
Stores the assessment schedule. Each row = one week's assessment plan.

Columns: Phase, Batch, Week, Date, Time (start–end), Mock Assessment (required/not required + mock date/time), Subjects & Topics.

Two upload modes:
1. **Manual Add** — dynamic subject rows (add/remove), mock fields appear/hide based on toggle
2. **CSV Upload** — template: `phase, batch, week, assessment_date, start_time, end_time, mock_assessment, mock_date, mock_start_time, mock_end_time, subjects, topics`

Saving a syllabus entry automatically calls `ensureConfigDoc()` which creates a matching `topic_configs` document if one doesn't exist yet (prevents duplicate config creation). Time fields are synced to the config doc via `syncTimesToConfig()`.

### Topin Configs (`page-configs`)
Config links for Topin assessments. Each config = one assessment slot (main + optional mock).

Fields per config: `main_config_link` (required), `mock_config_link` (optional), `domain` (e.g. "Mathematics").

Status flow: `pending` → `submitted` (when Content Team adds links) → `published` (when published to Topin).

Two upload modes:
1. **Manual Add** — dropdowns for phase/batch/week (populated from existing syllabus), link fields
2. **CSV Upload** — template columns: `phase, batch, week, main_config_link, mock_config_link`. Old CSVs using `config_link` are auto-normalised to `main_config_link` for backward compat.

"Sync from Syllabus" button creates missing config docs for all existing syllabus entries.

### Assessments (`page-assessments`)
Publish configs to Topin and invite students.

For each config, the flow is:
1. **Publish** — triggers `publishToTopin()` which calls the local automation server (Playwright) to fill Topin's web form and publish the assessment
2. **Invite Students** — calls `/api/invite` (Vercel function) which batches student UIDs in groups of 20 and POSTs to the external invite API (3 retries per batch)
3. **Mark Invites Sent** — manual status update if invites were done outside the portal

Publishing opens a progress modal with SSE live logs streamed from the local server.

### Assessment Details (`page-assessment-details`)
SLA tracking dashboard. For each config, shows a pipeline of stages with deadlines and completion status:

**SLA Stages (phase-dependent deadlines from `computeSLADeadlines()`):**
- Config Link Submission
- Assessment Publishing  
- Student Invites
- Submission Link Collection
- Marks Entry

Breach detection runs in `checkAndNotifyBreaches()` — for each breached stage, it creates a `notifications` doc and sends an email via EmailJS.

Escalation: if a breach is not resolved after N hours (configurable), `recordAndEscalate()` re-notifies with an escalation card.

Breach badges appear in the sidebar nav when any SLA is overdue. Clicking "Mark Read" on a breach dismisses it.

### Assignments (`page-assignments`)
Coordinator workflow between teams for content assignment.

**Flow:**
1. Someone raises an assignment request (phase/batch/week/domain/subjects)
2. Content Team submits links (assessment links, submission form links, etc.) via "Submit Links" / "Edit Links"
3. On-Ground Team downloads allocation CSV (student→set mapping)
4. Instructor evaluates students using the full-screen Evaluate modal
5. Evaluated scores can be exported as CSV or imported from a submission CSV

**Actions column** (role-dependent): one primary CTA button (Evaluate / Submit Links / ↓ CSV) + `⋮` overflow menu with secondary actions (Edit Links, View Links, Download CSV, Delete).

Evaluate modal is full-screen (100vw × 100vh). Students can be scored per subject, total scores auto-computed. Import CSV lets instructors paste a bulk submission CSV.

### Interviews (`page-interviews`)
Two tabs:
1. **IC Interviews** — reads scheduled interviews from IC Firebase via `/api/ic-interviews`. Shows candidate name/email, interviewer, scheduled date, status. Filter by phase/batch/week. This is read-only from the IOE portal's perspective.
2. **Request Interview** — form to select students and a requested date, then POSTs to `/api/ic-request` which writes `interview_requests` docs to IC Firebase to be picked up by IC automation.

### Teams (`page-teams`)
Admin-only. Shows all registered portal users, their role/status. Admin can:
- Approve/reject pending registrations
- Change a user's team/role
- Delete user records (note: only removes from `team_members`, NOT from Firebase Auth — Firebase Console needed for full revocation)
- Register new users directly (bypasses email confirmation)

### About (`page-about`)
Role guides and downloadable documentation for each team.

---

## Vercel Serverless Functions (`api/`)

### `POST /api/invite`
Proxies student invitation requests to an external assessment API.
- Body: `{ apiEndpoint, apiToken, candidates: [uid, ...], assessmentId }`
- Sends in batches of 20, 3 retries per batch with exponential backoff
- Returns: `{ total, sent, failed, batches[], errors[] }`

### `GET /api/ic-interviews`
Reads interview data from the IC Firebase project.
- No request body
- Requires `IC_SA_B64` env var (base64-encoded service account JSON)
- Filters Firestore `interviews` collection where `templateName >= "Intensive" && < "Intensivf"` (captures "Intensive_Evaluation_Weekly" and "Intensive_React Evaluation_BM" templates)
- Returns: `{ ok, count, interviews[] }`

### `POST /api/ic-request`
Writes interview schedule requests to IC Firebase.
- Body: `{ students: [{uid, name, email, phase, batch, week}], requestedDate, requestedBy }`
- Requires `IC_SA_B64` env var
- Writes to `interview_requests` collection with `status: "pending"` and `source: "ioe-portal"`
- Uses batch write (one Firestore write per student)

---

## Local Automation Server (`server/`)

The local server is an Express + Playwright app. **Playwright is used only for OTP login.** Assessment publishing uses the **Topin REST API directly** (no browser form-filling).

**It runs on the user's laptop, not on Vercel.** The portal's browser connects to it at `http://localhost:3001`.

### Setup
```powershell
cd server
npm install
npx playwright install chromium
node index.js
# Or use start.ps1
```

### Server Files

| File | Purpose |
|---|---|
| `index.js` | Express server with OTP flow + direct API publish routes |
| `topin-client.js` | All Topin API logic: token refresh, tag gen, publish, GraphQL polling |
| `seb-template.xml` | SEB browser configuration XML (uploaded with each SEB-mode assessment) |
| `invite-email-template.html` | Invite email body sent to students |
| `topin-tokens.json` | Saved IB + Topin OAuth tokens (gitignored — stays on local machine) |

### API Endpoints (local, port 3001)

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | Health check |
| `GET /api/publish/token-status` | Check if Topin token is valid (drives UI indicator) |
| `GET /api/publish/progress` | SSE stream — live publish logs |
| `POST /api/publish/start` | Open Chromium, navigate to Topin login, trigger OTP |
| `POST /api/publish/verify-otp` | Fill OTP in browser; **captures IB + Topin tokens** via network interception |
| `POST /api/publish/run` | Publish via direct Topin REST API (no browser) |
| `POST /api/publish/cancel` | Cancel an in-progress job |

### Direct API Publish Flow (new)
1. Portal opens **Topin Publish Setup modal**: user enters assessment title, sees auto-generated exam tag + exit PIN, selects target (Main/Mock/Both)
2. Portal calls `/run` → server tries 3-level token refresh:
   - Level 1: use cached Topin access token if not expired
   - Level 2: exchange IB access token for new Topin token via `code/v1` + `auth_code/v2`
   - Level 3: refresh IB session via `token/refresh/v1`, then do level 2
3. If all levels fail → responds `{ status: "needs_otp" }` → portal shows OTP form
4. If token obtained → calls `POST /api/nw_assess_config/user/org_assess/publish/` (double-encoded body)
5. Polls GraphQL (`topin-config-prod-apis.ccbp.in`) with [2,3,4,5,5,5,5]s delays until published assessment appears
6. Broadcasts `done` event via SSE with `assessmentLink`, `publishedAssessId`, `exitPin`, `uniqueExamId`
7. Portal updates Firestore config doc with all publish details

### OTP Flow (only needed when all tokens expired)
1. Portal calls `/start` with mobile → Chromium opens `config.topin.tech`, triggers OTP
2. Response listener is set up on the Playwright browser context to capture IB + Topin tokens
3. User enters OTP → portal calls `/verify-otp` → OTP filled in browser
4. On auth complete, network interception captures `ib_access_token` and `topin_access_token`
5. Tokens saved to `server/topin-tokens.json` — future publishes skip OTP entirely

### Tag Generation Rules
Each assessment gets a unique `uniqueExamId` tag based on phase/batch/week/domain:

| Phase | Mock Tag | Main Tag |
|---|---|---|
| P1 | `IO26_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT_{B}_{W}` | `IO26_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT_{B}_{W}` |
| P2 | `IO26BM_INTENSIVE_OFFLINE_MOCK_NXTMOCK_{B}_{W}` | `IO26BM_INTENSIVE_OFFLINE_MAIN_ASSESSMENT_{B}_{W}` |
| P3 Python | `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MOCK_ASSESSMENT_PYTHON_{B}_{W}` | `IO26_P3_INTENSIVE_OFFLINE_MAIN_INTERVIEW_PYTHON_{B}_{W}` |
| P3 Java | `IO26_P3_INTENSIVE_OFFLINE_MOCK_INTERVIEW_JAVA_{B}_{W}` | `IO26_P3_INTENSIVE_OFFLINE_WEEKLY_MAIN_ASSESSMENT_JAVA_{B}_{W}` |
| P4 Weekly | `IO26BM_P4_INTENSIVE_OFFLINE_MOCK_ASSESSMENT_{D}_{B}_{W}` | `IO26BM_P4_INTENSIVE_OFFLINE_MAIN_ASSESSMENT_{D}_{B}_{W}` |
| P4 NxtMock | `IO26BM_P4_INTENSIVE_OFFLINE_MOCK_NXTMOCK_{D}_{B}` | — |
| P4 NxtMock TR1 | — | `IO26BM_P4_INTENSIVE_OFFLINE_MAIN_NXTMOCK_{D}_TR1_{B}` |
| P4 NxtMock TR2 | — | `IO26BM_P4_INTENSIVE_OFFLINE_MAIN_NXTMOCK_{D}_TR2_{B}` |

### Invite API
`POST /api/invite` (Vercel serverless) sends student UIDs to:  
`https://nxtwave-assessments-backend-topin-prod-apis.ccbp.in/api/nw_integrations/invite/assess/candidates/v2/`  
API key stored as Vercel env var `TOPIN_INVITE_API_KEY` — never exposed to browser.

---

## Key Code Patterns

### Global State (top of `app.js`)
All loaded data lives in module-level `let` variables:
- `allStudents`, `allSyllabus`, `allConfigs` — loaded once per page visit, filtered client-side
- `currentUserEmail`, `currentUserTeam`, `isGuest` — set in `onAuthStateChanged`, read everywhere
- `_allNotifs`, `_emailjsConfig`, `_batchSchedules` — lazy-loaded on first use

### Page Switching
`switchPage(name)` shows/hides `.page` divs by matching `id="page-{name}"`. Each page has a load function (`loadStudents()`, `loadSyllabus()`, etc.) called on switch. Data is not cached between page switches — always re-fetched from Firestore.

### Role Gating
`applyRoleAccess(team)` runs after login and uses CSS classes + `display:none/flex` to show/hide nav items and action buttons. The `isGuest` flag and `currentUserTeam` are checked inline in render functions (e.g. `renderAssignmentsTable`) to conditionally include or exclude action buttons per row.

### CSV Download
`downloadCSV(rows, filename)` converts a 2D array to CSV text and triggers a browser download using a blob URL.

### Toast Notifications
`toast(message, type)` shows a brief slide-in notification. Types: `"info"`, `"success"`, `"error"`.

### Modal System
Modals have class `modal-backdrop`. `closeModal(id)` removes `"open"` class. Opening modals add `"open"` class. The eval-list modal uses `modal-backdrop.fullscreen` to render at 100vw × 100vh.

### Firestore Query Pattern
All reads use `getDocs` (one-time fetch, not real-time listeners). Firestore indexes are required for compound queries — if a query fails with "missing index", you must create it in Firebase Console → Firestore → Indexes.

### SLA Computation
`computeSLADeadlines(phase, assessmentDateStr)` returns deadline timestamps for each pipeline stage based on phase type (determined by `getPhaseType(phase)` — e.g. P1/P2 have different SLA windows). `slaStatus(deadline, completedAt)` returns `"ok"`, `"warning"`, `"breach"`, or `"pending"`.

---

## Common Tasks

### Add a new page
1. Add a nav item in `index.html` (inside `.sidebar-nav`)
2. Add `<div class="page" id="page-yourname">` in `index.html`
3. Add a case in `switchPage()` in `app.js` that calls your load function
4. Add role visibility logic in `applyRoleAccess()` if needed
5. Update nav-section `id="nav-section-*"` visibility if it belongs to an existing section

### Add a new Firestore collection
- No schema declaration needed — Firestore is schemaless
- Define the shape as a comment near the function that writes it
- Add compound indexes in Firebase Console if you're using `orderBy` + `where` together

### Add a new Vercel API endpoint
1. Create `api/your-endpoint.js` with a default export `async function handler(req, res)`
2. It's automatically available at `/api/your-endpoint` after `vercel --prod`
3. Use ESM (`import`/`export`) — Vercel auto-compiles to CJS
4. If it needs Firebase Admin, follow the `getIcDb()` lazy-init pattern in `ic-interviews.js`

### Change CSV column names / template
- `downloadTemplate()` — student template
- `downloadSyllabusTemplate()` — syllabus template
- `downloadConfigTemplate()` — config template
- The corresponding upload parser (`uploadCSVToFirebase`, `uploadSyllabusCSV`, `uploadConfigsCSV`) must be updated to match. Use `normHeaders` pattern (see `parseConfigCSV`) for backward compat if old CSVs exist.

### Add a new role
1. Add to the `<select id="reg-team">` options in `index.html`
2. Add handling in `applyRoleAccess(team)` in `app.js`
3. Add role checks inline wherever action buttons are rendered

---

## Known Issues & Gotchas

### Login Slowness
Firebase "Email Enumeration Protection" causes `signInWithEmailAndPassword` to hang for 2+ minutes when enabled. Keep it **disabled** in Firebase Console → Authentication → Settings → User actions. The login has a 30-second timeout that re-enables the button with an error message.

### Vercel Manual Deploy Required
`git push` alone does not redeploy. Always run `vercel --prod` after pushing changes.

### Local Server Not on Vercel
The `server/` directory with Playwright is a local tool. It must be running on the user's own machine for Topin publishing to work. Users on different machines must each install and run it locally (`cd server && npm install && node index.js`).

### Firebase SDK from CDN
All Firebase JS is loaded from `https://www.gstatic.com/firebasejs/10.12.2/`. If Google's CDN is slow, the page is slow. This could be optimised by bundling locally but is not currently done.

### `team_members` and Firebase Auth are separate
Deleting a user from `team_members` (via the Teams page) does NOT delete their Firebase Auth account. They can still log in but will see "pending" or "rejected" screen. To fully revoke access, also delete from Firebase Console → Authentication → Users.

### IC Firebase Access Requires Service Account
`api/ic-interviews.js` and `api/ic-request.js` require `IC_SA_B64` set in Vercel. If not set, these endpoints return 503. The service account JSON comes from the IC Firebase project (not the IOE project).

### Topin Session State
Topin's `config.topin.tech` stores auth state in React memory (not persistent cookies/localStorage). If the user navigates away from the active Playwright browser page, auth is lost and a new OTP is required. The local server preserves the original post-auth page (`activePg`) to avoid this. Never close the Chromium window between publish runs.

### No Real-time Updates
All data is fetched on page load/switch. If someone else updates data while you're viewing it, you won't see changes until you navigate away and back. There are no Firestore `onSnapshot` real-time listeners.

---

## CSS Variables (from `styles.css`)

```css
--primary      /* #6366f1  — purple/indigo */
--primary-dark /* #4f46e5 */
--surface      /* #ffffff (card bg) */
--bg           /* #f8fafc (page bg) */
--text         /* #1e293b */
--muted        /* #64748b */
--border       /* #e2e8f0 */
--danger       /* #ef4444 */
--success      /* #10b981 */
--warning      /* #f59e0b */
```

Dark mode is not currently implemented (no `prefers-color-scheme` override).
