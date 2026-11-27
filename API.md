# Flute Gandharvas CRM — API contract (module 1: Hackathon attendance)

All endpoints are JSON under `/api`. Auth is an HttpOnly cookie set by login.
`401` → show the login screen. `403` → the role may not see this.
Roles: **Admin** (everything), **Team member** (Learners, Learner profile, Lists), **Viewer** (Overview only).

Ids: batch ids and learner ids are integers. Session ids are strings `"<batchId>-<slot>-<YYYY-MM-DD>"`.
Review identity keys are strings like `"email:x@y.com"` or `"name:ravi s iphone"` (URL-encode them).

## Auth
| Method | Path | Body | Returns |
|---|---|---|---|
| POST | /api/auth/login | `{email, password}` | `{user}` |
| POST | /api/auth/logout | – | `{ok:true}` |
| GET | /api/auth/me | – | `{user}` where `user = {id, name, email, role, initials}` |

## Read
### GET /api/bootstrap (any role)
```js
{
  user,
  meta: { today: "2026-12-06", lastSyncedIso: "…"|null, goalRetentionPct: 60, baselineRetentionPct: 48 },
  rules: { attendedMinMinutes, lateThresholdMinutes, leftEarlyMinutes, regularStreakWeeks, regularMinMinutes,
           missedTwiceCount, activeWindowDays, attendedSessionTypes[], regularSessionTypes[], missedTwiceSessionTypes[] },
  batches: [{ id, name, shortName, startDate, status: "Upcoming"|"Active"|"Completed", calendarWeek, meetingsConfigured, hasData }],
  defaultBatchId,            // active batch, else latest started, else first; null when no batches
  sync: {
    sources: [{ id: "zoom1"|"zoom2"|"tagmango", name, account, type, connected, status: "Synced"|"Sync failed"|"Partial"|"Never synced"|"Not connected"|"Running",
                lastSyncIso, recordsPulled, nextRunIso, errorMsg }],
    alerts:  [{ id, severity: "red"|"amber", title, detail, actionLabel, actionHash }]
  },
  unmatchedCount             // Admin only (0 for others)
}
```

### GET /api/batches/:id/overview (Admin, Viewer)
```js
{
  batch: { id, name, shortName, startDate, status, totalWeeks: 7, currentWeek, calendarWeek, hasData, meetingsConfigured,
           phaseSummary: { All: {p1, p2}, India: {p1, p2}, Overseas: {p1, p2} } },
  prevBatch: { shortName, curve: { p1: [100, 67, …], p2: [...] } } | null,   // % of week 1, null entries = not held
  alerts: [...same shape as bootstrap...]
}
```
Each `p1`/`p2`:
```js
{ label, weekOffset /* 0 for P1, 7 for P2 → show weeks 8–14 */, configured,
  paid /* matched learners in roster */, refunded, registered /* Zoom registrants of the Sunday meeting */,
  denominator /* registered, or paid when no registrants */,
  w1Attended, currentWeek, currentWeekAttended, avgMinutes, stayed60Pct, lateJoiners,
  weeklySundayAttended: [n|null ×7],
  weeklyNewVsReturning: [{week, label, newCount, returningCount}],
  funnelByWeek: { "1": {registered, joined, attended20, stayed60}, … },
  sessionTypeRates: { sunday: [pct|null ×7], tuesday: [...], thursday: [...] } }
```

### GET /api/batches/:id/sessions (Admin)
`{ sessions: [ { id, batchId, slot, week, weekLabel, date, day, phase, type, startTime, durationMin, zoomAccount, meetingId,
status: "Synced"|"Upcoming"|"Awaiting data"|"Sync failed", syncError, registered, joined, attended, avgMinutes, peakConcurrent, pctLate, pctLeftEarly } ] }`
(`joined`…`pctLeftEarly` are null unless status is Synced.)

### GET /api/sessions/:id (Admin)
Session summary fields plus `attendanceOverTime: [{minute, count}]` and
`participants: [{ personKey, zoomName, zoomEmail, learnerId|null, learnerName|null, region, segments: [{startMin, endMin}], totalMinutes, rejoins, firstJoinOffset, lastLeaveOffset }]`.
`zoomAccount` is the account key; `zoomAccountLabel` gives its display name.

### GET /api/batches/:id/learners (Admin, Team member)
`{ learners: [ { id, rowKey, name, email, phone, country, region, batchId, phase, status: "active"|"at_risk"|"inactive"|"late_joiner"|"moved"|"refunded",
doNotContact, paymentDate, paymentPlatform, weeksAttended, heldWeeks, currentStreak, totalMinutes, regularityScore, isRegular, bestRegularRun,
missedStreak, isMissedTwice, firstAttendedWeek, lastAttendedDate, lastAttended, matchMethod: "email"|"phone"|"manual"|"none",
weeks: [{ week, label, sun, tue, thu, status: "attended"|"partial"|"missed"|"nosunday"|"upcoming" }] } ] }`
A learner in both phases appears twice (same `id`, different `rowKey`/`phase`).

### GET /api/learners/:id?batchId= (Admin, Team member)
Learner row fields for that batch (or their latest batch) plus
`sessionTimelines: [{ sessionLabel, date, startTime, durationMin, minutes, segments }]` (most recent first, max 8),
`batchHistory: [{ batch, event, date }]`, `linkedZoomNames: [{ zoomName, zoomEmail, via }]`, `inBatch: boolean`.

### GET /api/batches/:id/lists (Admin, Team member)
`{ missedTwice: [row], diamondShowcase: [row], activeOnly: [row], lateJoiners: [row], notPaid: [{id, zoomName, zoomEmail, phone, phase, sessionsAttended, totalMinutes, lastSeen, note}], doNotContact: [row], dncExcludedCount }`
`activeOnly` is across ALL batches (attended within `activeWindowDays`), not just this batch.

### GET /api/batches/:id/review (Admin)
`{ items: [{ id /*identity key*/, zoomName, zoomEmail, phone, region, phase, sessionsSeen, totalMinutes, lastSeen,
suggestions: [{learnerId, name, email, phone, confidence, reason}] }] }`

### GET /api/learners/search?q= (Admin)
`{ results: [{id, name, email, phone}] }` (max 20)

### GET /api/sync (Admin)
`{ sources, alerts, logs: [{ id, time /*ISO*/, source, status, records, durationSec, note, error }] }`

### GET /api/settings (Admin)
```js
{ rules,
  batches: [{ id, name, startDate, status, meetings: [{ id, slot, zoomAccount, meetingId, registrationUrl, topic, startTime, durationMin, resolveError }] }],
  zoomAccounts: [{ key, label, connected }],
  team: [{ id, name, email, role, active }],
  dnc: [{ key, note, addedAt }],
  tagmango: { webhookUrl, apiKeyConfigured, pullConfigured, learnersCount, lastEventIso } }
```

## Write (Admin unless noted)
| Method | Path | Body | Notes |
|---|---|---|---|
| POST | /api/review/resolve | `{identityKey, action: "match"\|"not_learner"\|"skip", learnerId?}` | remembered for future syncs |
| POST | /api/sync/run | `{source: "zoom"\|"tagmango"\|"all"}` | returns `{results}` after the sync finishes |
| PUT | /api/settings/rules | `{rules}` | returns `{rules}` |
| POST | /api/batches | `{startDate, name?}` | startDate must be a Sunday |
| PUT | /api/batches/:id | `{name?, startDate?}` | |
| DELETE | /api/batches/:id | – | removes its meetings and synced Zoom data |
| POST | /api/batches/:id/meetings | `{slot, zoomAccount, ref, startTime?, durationMin?}` | `ref` = meeting ID or Zoom link (registration links are resolved on next sync) |
| PUT | /api/meetings/:id | `{zoomAccount?, ref?, startTime?, durationMin?}` | |
| DELETE | /api/meetings/:id | – | |
| POST | /api/users | `{name, email, role, password}` | |
| PUT | /api/users/:id | `{name?, role?, active?, password?}` | |
| DELETE | /api/users/:id | – | cannot delete yourself |
| POST | /api/dnc | `{values: "one email or phone per line", note?}` | returns `{added}` |
| DELETE | /api/dnc/:key | – | key URL-encoded, e.g. `email%3Ax%40y.com` |
| POST | /api/learners/import | `{csv, platform?}` | TagMango/Razorpay export; returns `{inserted, updated, skipped, errors[]}` |
| POST | /api/tagmango/register-webhooks | – | registers order + refund webhooks with TagMango |
| POST | /api/webhooks/tagmango?secret=… | TagMango payload | public, secret-protected |
