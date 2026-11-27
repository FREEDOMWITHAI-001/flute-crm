# Flute Gandharvas CRM — Module 1: Hackathon Attendance & Retention

Pulls every Sunday / Tuesday / Thursday hackathon session from **both Zoom accounts**, matches each attendee to a
**paid learner from TagMango**, and shows retention week by week, late joiners, regular learners and export-only
lists. Nothing is ever sent to learners from this tool.

## Run it

```bash
npm install
cp .env.example .env      # fill in ADMIN_EMAIL / ADMIN_PASSWORD at minimum
npm start                 # http://localhost:3000
npm test                  # unit + end-to-end tests, no network needed
```

Without `DATABASE_URL` the app uses a built-in Postgres stored in `./data/pg` (good for testing).
For production set `DATABASE_URL` to a Postgres owned by Flute Gandharvas (e.g. a Supabase project in their account).

## First-time setup (in the app, as Admin)

1. **Settings → Batch & Zoom calendar → Add batch**: the batch start date (a Sunday, e.g. 6 Dec 2026).
2. Add the batch's 4 Zoom meetings. Paste the meeting ID **or** the registration link Harsh shared, and pick the
   Zoom account it runs on:
   | Slot | Who it is |
   |---|---|
   | Learning – Phase 1 (Sunday) | the new batch, weeks 1–7 |
   | Practice & Q&A – Phase 1 (Tue + Thu, same link) | the new batch |
   | Learning – Phase 2 (Sunday) | the previous batch continuing, weeks 8–14 |
   | Practice & Q&A – Phase 2 (Tue + Thu, same link) | the previous batch |
3. **Sync & Alerts → TagMango → Import CSV** with the TagMango buyers export (any column order; name, email, phone,
   country, payment date, status are detected). New orders/refunds then arrive by webhook (Settings → TagMango).
4. **Sync now** on each Zoom card (it also runs automatically every `SYNC_INTERVAL_MINUTES`).

## How the two Zoom accounts work

- Each account has its own Server-to-Server OAuth app (`ZOOM_1_*`, `ZOOM_2_*` in `.env`), read-only scopes only.
- Every meeting in the calendar is tagged with the account it lives on; the sync asks **that** account for it.
- Sessions from both accounts land in the same batch and are combined per phase/week — on screen each session also
  shows which account it came from, and the Sync page shows each account's own status, last run and errors.
- If one account fails, the other still syncs; its sessions show "Sync failed" and an alert appears.

## How a person is counted

- **Batch member (Phase 1)**: registered on the Phase 1 Zoom link (registration is compulsory since 15 Nov) or attended
  any Phase 1 session, and matched to a paid TagMango learner.
- **Matching order**: Zoom/registration email → registration phone → a match confirmed by hand in the Review queue
  (remembered forever). Name-only matches are never automatic.
- **Attended**: at least 20 minutes in the session, rejoins and second devices merged (configurable).
- **Late joiner**: first attended Phase 1 session is week 2 or later → should restart next batch.
  **Moved**: a late joiner who then attends the next batch's Phase 1.
- **Regular (Diamond Showcase)**: 3 Sunday learning sessions in a row with 60+ minutes each (configurable).
- **Missed twice**: the last 2 Sunday learning sessions missed after attending at least once.
- **Active only**: attended anything in the last 14 days, across all batches.
- **Do-not-contact** people are removed from every list.

## Code map

| File | What it does |
|---|---|
| `server/model.js` | All analytics (pure functions, unit-tested) |
| `server/match.js` | Email/phone normalisation, identity matching, review suggestions |
| `server/zoom.js` | Zoom API client (OAuth, retries, paging) |
| `server/sync.js` | Pulls Zoom instances, participant reports and registrants into Postgres |
| `server/tagmango.js` | TagMango webhooks, CSV import, optional pull |
| `server/store.js` | Loads data, caches the model per batch, alerts |
| `server/index.js` | HTTP API (see `API.md`) and the sync scheduler |
| `server/auth.js` | Login, sessions, roles (Admin / Team member / Viewer) |
| `public/index.html` | The dashboard |
