Build a complete, production-quality front-end prototype for "Flute Gandharvas CRM" — module 1: Hackathon Attendance & Retention. Output a SINGLE self-contained index.html (HTML + CSS + vanilla JavaScript, no frameworks, no build step). Charts may use Chart.js from https://cdn.jsdelivr.net/npm/chart.js. Font: Inter from Google Fonts. All data must come from ONE mock-data object at the top of the script (`const DATA = {...}`) so a developer can later replace it with real API calls — no data hard-coded inside the markup. Every screen is rendered by JS from DATA.

## CONTEXT (the business)
Flute Gandharvas teaches flute online. Learners pay (via TagMango) and join a 14-week live "Hackathon" on Zoom:
- Phase 1 = weeks 1–7, Straight Flute. Phase 2 = weeks 8–14, Side Flute.
- A new batch starts every 7 weeks, so Phase 1 of the new batch and Phase 2 of the previous batch run IN PARALLEL.
- Each phase has 3 sessions a week:
  - Sunday "Learning Session" (Phase 1 at 7 pm, Phase 2 at 9 pm) — separate Zoom meeting per phase.
  - Tuesday "Practice" and Thursday "Q&A / Inner Circle" — Tue and Thu SHARE one Zoom meeting per phase (show them as separate sessions, split by date).
- Late joiners: someone whose first attendance is week 2 or later is flagged "Late joiner" and expected to restart at week 1 of the NEXT batch (they don't watch recordings).
- Data comes from Zoom (join/leave times per person, a person can join and leave several times in one session) matched to paid learners from TagMango by email → phone → name.
- Rules (show them in Settings, editable): Attended = at least 20 minutes total in a session (rejoins added up). Regular learner = 3 Sunday learning sessions in a row AND at least 1 hour each. Missed-twice = 2 consecutive Sunday learning sessions missed.
- Goal shown on the dashboard: week 1 → week 7 retention from 48% to 60%.
- The tool only SHOWS lists and exports them. It never calls or messages anyone. No "send" buttons — only "Export CSV" and "Copy numbers".

## LAYOUT
- Left sidebar (collapsible, icon + label). Top section "Hackathon" with the screens below. Lower section "Coming soon" with greyed, non-clickable items: Webinars, Leads & Ads, Payments, Support Inbox, Mentors & 1:1 Hours, GoSorilla. This is the first module of a bigger CRM/ERP — the shell must feel ready for those.
- Top bar: page title, a global BATCH switcher (e.g. "Batch starting 6 Dec 2026" / "Batch starting 11 Oct 2026"), a PHASE filter (All / Phase 1 Straight / Phase 2 Side), region filter (All / India / Overseas), "Last synced 12 min ago" with a status dot, and a user avatar menu showing role.
- Hash-based routing (#/overview, #/sessions, #/session/:id, #/learners, #/learner/:id, #/lists, #/review, #/sync, #/settings) so each screen has a URL.
- Responsive: works at 1440px, 1024px and 390px (phone). On phone the sidebar becomes a bottom sheet/hamburger, tables become stacked cards, no horizontal page scroll.
- Light and dark theme with a toggle; define all colours as CSS variables.

## DESIGN DIRECTION
Clean, calm, glanceable — "one look and I know if the batch is healthy". Generous whitespace, 8px spacing grid, cards with subtle borders (not heavy shadows), 12px radius. One brand accent (deep teal #0F766E) plus semantic colours: green = good, amber = watch, red = problem. Numbers big and bold, labels small and muted. Use tabular numerals for all figures. Every KPI shows a rate AND the counts behind it (e.g. "62% · 731 of 1,178"), never a raw count alone. Sticky table headers, sortable columns, search boxes, pill badges for status. Skeleton loaders while "loading", friendly empty states with an icon and one line of guidance.

## SCREENS

1. OVERVIEW (#/overview)
   - KPI row: Paid learners in batch · Week-1 attendance · Current week attendance · W1→W7 retention (with goal 60% marker) · Avg minutes per learner · Late joiners · Unmatched to review.
   - Big retention curve (line chart) week 1→7 for the selected batch, goal line at 60%, previous batch as a faded comparison line.
   - Stacked bar per week: New vs Returning attendees (answers "of 795 in week 2, how many are new?").
   - Mini funnel per week: Registered → Joined → Attended (20+ min) → Stayed 60+ min.
   - Session-type trend: three small multiples for Sunday Learning, Tuesday Practice, Thursday Q&A.
   - "Needs attention" card: e.g. "Week 3 Sunday attendance down 18% vs week 2", "Zoom account 2 sync failed", "42 unmatched participants".
   - Phase 1 and Phase 2 shown side by side when filter = All (they run in parallel).

2. SESSIONS (#/sessions)
   - Calendar-style week grid AND a table toggle. Each session card: date, day, phase, type, Zoom account, registered, joined, attended (20+), avg minutes, peak concurrent, % late (joined >10 min after start), % left early.
   - Status badges: Upcoming / Live / Synced / Sync failed.

3. SESSION DETAIL (#/session/:id)
   - Header stats as above.
   - "Attendance over time" area chart: people present minute by minute (shows when people arrive and drop off).
   - Participant table: name, email, matched learner (or "Unmatched" badge), first join, last leave, total minutes, number of rejoins, attended yes/no, late, left early.
   - Expandable row → TIMELINE BAR showing each join/leave segment across the session length (present = filled, absent = gap), with times on hover. This "present/absent timestamps" view is a key requirement — make it beautiful.

4. LEARNERS (#/learners)
   - Table of all paid learners in the batch: name, phone, email, country/region, phase, status (Active / At risk / Inactive / Late joiner / Moved to next batch / Refunded), weeks attended, current streak, total minutes, regularity score (0–100 with a small bar), last attended.
   - Attendance heat strip per row: 7 small squares for weeks 1–7 (green attended, amber joined <20 min, grey missed, outline = upcoming).
   - Filters: status, phase, region, regular yes/no, missed-twice yes/no. Search by name/email/phone. Bulk select → Export CSV.

5. LEARNER PROFILE (#/learner/:id)
   - Header: name, contact, payment date and platform, batch, phase, status badges, regularity score.
   - Week-by-week grid for Sunday / Tuesday / Thursday with minutes in each cell.
   - Timeline of every session with join/leave segments.
   - Batch history (e.g. "Joined 11 Oct batch in week 3 → flagged late joiner → restarted 6 Dec batch").
   - Matching info: how they were matched (email / phone / manual) and Zoom names/emails linked to them.

6. LISTS (#/lists) — tabs, each with count, rule explanation line, table, Export CSV and Copy numbers buttons:
   - Missed twice (2 Sunday learning sessions in a row).
   - Diamond Showcase — most regular learners (3 in a row + 1 hr each), ranked by regularity score, with "how many to invite" input that cuts the list.
   - Active only (for bulk messaging so inactive members are skipped).
   - Late joiners → next batch.
   - Attended but not a paid learner (in Zoom, not in TagMango).
   - Do-not-contact (always excluded from every other list; show a small "excluded: 12" note on each list).

7. REVIEW QUEUE (#/review)
   - Zoom participants that couldn't be matched automatically. Each card: Zoom display name, Zoom email (if any), sessions seen, total minutes, and up to 3 suggested learners with a confidence %. Actions: "Match to…" (searchable dropdown), "Not a learner", "Skip". Show that a manual match is remembered next time. Never auto-guess — make that copy explicit.

8. SYNC & ALERTS (#/sync)
   - Cards for each source: Zoom account 1 (connect@daveharsh.com), Zoom account 2, TagMango — status, last sync, records pulled, next run, "Sync now" button.
   - Sync log table and an alerts list (sync failed, attendance dip, many unmatched).

9. SETTINGS (#/settings)
   - Rules with editable inputs: Attended minimum minutes (20), Late threshold minutes (10), Regular learner (3 weeks in a row, 60 min each), Missed-twice count (2), which session types count for each rule (checkboxes: Sunday / Tuesday / Thursday).
   - Batch & session calendar: list of batches and their 4 Zoom meetings (Learning P1, Learning P2, Practice & Q&A P1, Practice & Q&A P2) with meeting ID, account, day/time.
   - Team & roles: Admin (Harsh, Priya — see everything), Team member (sees Lists and Learners only), Viewer (Overview only). Role switcher in the avatar menu must visibly hide screens the role can't see.

## MOCK DATA (realistic, enough to make every screen look full)
- Two batches: "11 Oct 2026" (completed weeks 1–7; Sunday learning attendance 1,178 → 795 → 707 → 643 → 600 → 580 → 566) and "6 Dec 2026" (week 1 done, rest upcoming).
- ~60 learners with Indian and some overseas names, +91 and international phones, every status represented (active, at risk, inactive, late joiner, moved to next batch, refunded, do-not-contact).
- Sessions for both phases, Sunday/Tuesday/Thursday, with per-person join/leave segments including rejoins.
- 8 unmatched Zoom participants (nicknames like "Ravi's iPhone", "Flute Lover", "Guest 23").
- One failed sync on Zoom account 2, alerts populated.

## STATES & EDGE CASES TO SHOW
Empty batch (no sessions yet), upcoming session (no data), sync failed banner, zero results after filter, learner with no Zoom match, learner in two batches, refunded learner (greyed, excluded from retention), very long names, phone layout.

## CODE QUALITY
Semantic HTML, accessible (labels, focus rings, aria for tabs/menus, contrast AA), CSS variables for theme, small render functions per screen (renderOverview, renderSessions…), a single `api` object with stub functions (getBatches, getSessions, getSessionDetail, getLearners, getLearner, getLists, getUnmatched, matchParticipant, getSyncStatus, getSettings, saveSettings) that currently return DATA so they can be swapped for real fetch() calls. Comment each stub with the endpoint it will call.
