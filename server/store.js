// Loads rows from Postgres and builds (and caches) the analytics model per batch.
// Any write (sync, review decision, settings, import) calls invalidate().
import { q, q1 } from "./db.js";
import { buildBatchModel, phase1Attendees, activeLearners, DEFAULT_RULES, WEEKS, batchCalendar, buildJourney } from "./model.js";
import { suggestLearners, regionFor } from "./match.js";
import { todayIst, addDays, fmtShortDate } from "./time.js";
import { loadZoomAccounts } from "./zoom.js";

const cache = new Map();
let common = null;

export function invalidate() {
  cache.clear();
  common = null;
}

export async function getRules() {
  const row = await q1(`SELECT value FROM settings WHERE key = 'rules'`);
  return { ...DEFAULT_RULES, ...(row?.value || {}) };
}

export async function saveRules(rules) {
  const clean = {};
  for (const [k, def] of Object.entries(DEFAULT_RULES)) {
    if (!(k in rules)) continue;
    if (Array.isArray(def)) clean[k] = (Array.isArray(rules[k]) ? rules[k] : []).map(String);
    else {
      const n = Number(rules[k]);
      if (!Number.isFinite(n) || n < 0 || n > 600) throw Object.assign(new Error(`Invalid value for ${k}`), { status: 400 });
      clean[k] = Math.round(n);
    }
  }
  const merged = { ...(await getRules()), ...clean };
  await q(`INSERT INTO settings (key, value) VALUES ('rules', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [JSON.stringify(merged)]);
  invalidate();
  return merged;
}

async function loadCommon() {
  if (common && common.today !== todayIst()) invalidate(); // statuses depend on the date
  if (common) return common;
  const [learners, linkRows, dncRows, rules, batches] = await Promise.all([
    q(`SELECT id, name, email, phone, country, to_char(payment_date, 'YYYY-MM-DD') AS "paymentDate", platform, status FROM learners`),
    q(`SELECT identity_key, decision, learner_id, decided_at FROM identity_links`),
    q(`SELECT key FROM dnc`),
    getRules(),
    q(`SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS "startDate", break_weeks AS "breakWeeksJson" FROM batches ORDER BY start_date`)
  ]);
  const links = new Map(linkRows.map(r => [r.identity_key, { decision: r.decision, learnerId: r.learner_id, decidedAt: r.decided_at }]));
  for (const b of batches) {
    try { b.breakWeeks = JSON.parse(b.breakWeeksJson || "[]"); } catch { b.breakWeeks = []; }
    delete b.breakWeeksJson;
  }
  let syncErrors = new Map();
  try {
    const sync = await import("./sync.js");
    if (sync.lastErrorsByAccount) syncErrors = await sync.lastErrorsByAccount();
  } catch { /* sync module not ready yet */ }
  common = { learners, links, dnc: new Set(dncRows.map(r => r.key)), rules, batches, syncErrors, today: todayIst() };
  return common;
}

export async function listBatches() {
  return (await loadCommon()).batches;
}

async function loadBatchInputs(batch) {
  const meetings = await q(
    `SELECT id, slot, zoom_account AS "zoomAccount", meeting_id AS "meetingId", start_time AS "startTime", duration_min AS "durationMin", host_email AS "hostEmail"
       FROM batch_meetings WHERE batch_id = $1`, [batch.id]);
  const instances = await q(
    `SELECT i.uuid, i.batch_meeting_id AS "batchMeetingId", i.start_time AS "startTime", i.end_time AS "endTime"
       FROM zoom_instances i JOIN batch_meetings m ON m.id = i.batch_meeting_id WHERE m.batch_id = $1`, [batch.id]);
  const rows = await q(
    `SELECT p.instance_uuid AS "instanceUuid", p.name, p.email, p.registrant_id AS "registrantId",
            p.join_time AS "joinTime", p.leave_time AS "leaveTime"
       FROM zoom_participants p
       JOIN zoom_instances i ON i.uuid = p.instance_uuid
       JOIN batch_meetings m ON m.id = i.batch_meeting_id
      WHERE m.batch_id = $1`, [batch.id]);
  const meetingIds = [...new Set(meetings.map(m => m.meetingId).filter(Boolean))];
  const registrants = meetingIds.length
    ? await q(`SELECT meeting_id AS "meetingId", registrant_id AS "registrantId", email, first_name AS "firstName",
                      last_name AS "lastName", phone FROM zoom_registrants WHERE meeting_id = ANY($1)`, [meetingIds])
    : [];
  return { meetings, instances, rows, registrants };
}

async function modelFor(batchId, { shallow = false } = {}) {
  const key = `${batchId}:${shallow ? "shallow" : "full"}`;
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const c = await loadCommon();
    const batch = c.batches.find(b => b.id === Number(batchId));
    if (!batch) return null;
    let nextBatchPhase1People = new Set();
    if (!shallow) {
      const next = c.batches.find(b => b.startDate > batch.startDate);
      if (next) {
        const nm = await modelFor(next.id, { shallow: true });
        if (nm) nextBatchPhase1People = phase1Attendees(nm);
      }
    }
    const inputs = await loadBatchInputs(batch);
    return buildBatchModel({ batch, ...inputs, learners: c.learners, links: c.links, dnc: c.dnc, rules: c.rules, today: c.today, nextBatchPhase1People, syncErrors: c.syncErrors });
  })();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

export const getBatchModel = batchId => modelFor(batchId);

export async function defaultBatchId() {
  const c = await loadCommon();
  if (!c.batches.length) return null;
  const today = c.today;
  const active = [...c.batches].reverse().find(b => b.startDate <= today && today <= batchCalendar(b).lastDay);
  if (active) return active.id;
  const started = [...c.batches].reverse().find(b => b.startDate <= today);
  return (started || c.batches[0]).id;
}

export async function batchSummaries() {
  const c = await loadCommon();
  const out = [];
  for (const b of c.batches) {
    const m = await modelFor(b.id);
    const { phaseSummary, ...rest } = m.batch;
    out.push(rest);
  }
  return out;
}

export async function overview(batchId) {
  const m = await modelFor(batchId);
  if (!m) return null;
  const c = await loadCommon();
  const prev = [...c.batches].reverse().find(b => b.startDate < m.batch.startDate);
  let prevBatch = null;
  if (prev) {
    const pm = await modelFor(prev.id);
    const curve = s => (s.w1Attended && s.weeklyRetainedFromW1 ? s.weeklyRetainedFromW1.map(v => (v == null ? null : Math.round((v / s.w1Attended) * 100))) : null);
    const p1 = curve(pm.batch.phaseSummary.All.p1), p2 = curve(pm.batch.phaseSummary.All.p2);
    if (p1 || p2) prevBatch = { shortName: pm.batch.shortName, curve: { p1, p2 } };
  }
  return { batch: m.batch, prevBatch, alerts: await alerts(batchId) };
}

/** 14-week journey of the group that started in this batch (weeks 8–14 from the next batch's Phase 2). */
export async function journey(batchId) {
  const c = await loadCommon();
  const batch = c.batches.find(b => b.id === Number(batchId));
  if (!batch) return null;
  const next = c.batches.find(b => b.startDate > batch.startDate);
  const cur = await modelFor(batch.id);
  const nm = next ? await modelFor(next.id) : null;
  return buildJourney(cur, nm, c.rules);
}

export async function sessionDetail(sessionId) {
  const batchId = Number(String(sessionId).split("-")[0]);
  const m = await modelFor(batchId);
  return m?.sessionDetail.get(sessionId) || null;
}

export async function lists(batchId) {
  const m = await modelFor(batchId);
  if (!m) return null;
  const c = await loadCommon();
  const since = addDays(c.today, -(c.rules.activeWindowDays + WEEKS * 7));
  const recent = [];
  for (const b of c.batches) if (b.startDate >= since && b.startDate <= c.today) recent.push(await modelFor(b.id));
  return { ...m.lists, activeOnly: activeLearners(recent, { today: c.today, rules: c.rules }) };
}

export function reviewItems(batchId) {
  const key = `review:${batchId}`;
  if (cache.has(key)) return cache.get(key);
  const promise = (async () => {
    const m = await modelFor(batchId);
    if (!m) return null;
    const c = await loadCommon();
    const visible = m.unmatched.filter(u => {
      const link = c.links.get(u.id);
      return !(link && link.decision === "skip" && new Date(link.decidedAt).toISOString().slice(0, 10) >= u.lastSeen);
    });
    return visible.map((u, i) => ({ ...u, suggestions: i < 200 ? suggestLearners({ name: u.zoomName, email: u.zoomEmail }, c.learners) : [] }));
  })();
  cache.set(key, promise);
  promise.catch(() => cache.delete(key));
  return promise;
}

export async function unmatchedCount() {
  const id = await defaultBatchId();
  return id ? (await reviewItems(id)).length : 0;
}

export async function learnerProfile(learnerId, batchId) {
  const c = await loadCommon();
  const learner = c.learners.find(l => l.id === Number(learnerId));
  if (!learner) return null;
  const personKey = `learner:${learner.id}`;
  const appearances = [];
  const timelines = [];
  const linked = new Map();
  for (const b of c.batches) {
    const m = await modelFor(b.id);
    const rows = m.learners.filter(r => r.id === learner.id);
    rows.forEach(r => appearances.push({ batch: b, model: m, row: r }));
    for (const x of m.personSessions.get(personKey) || []) {
      timelines.push({
        sessionLabel: `Week ${x.phase === "Phase 2" ? x.week + WEEKS : x.week} · ${x.type} · ${x.phase}`,
        date: x.date, startTime: x.startTime, durationMin: x.durationMin, minutes: x.minutes, segments: x.segments
      });
    }
    const person = m.people.get(personKey);
    if (person) {
      for (const name of new Set(person.names)) {
        const k = `${name}|${person.emails[0] || ""}`;
        if (!linked.has(k)) linked.set(k, { zoomName: name, zoomEmail: person.emails[0] || "", via: person.via });
      }
    }
  }
  const chosen = appearances.find(a => a.batch.id === Number(batchId)) || appearances[appearances.length - 1] || null;
  const base = chosen?.row || {
    id: learner.id, name: learner.name, email: learner.email, phone: learner.phone, country: learner.country,
    region: regionFor(learner) || "Unknown", status: learner.status === "refunded" ? "refunded" : "inactive", phase: "—",
    doNotContact: false, paymentDate: learner.paymentDate || "", paymentPlatform: learner.platform || "TagMango",
    weeksAttended: 0, heldWeeks: 0, currentStreak: 0, totalMinutes: 0, regularityScore: 0, matchMethod: "none", weeks: [], lastAttended: "Never"
  };
  const batchHistory = appearances.map(({ batch, row }) => {
    let event;
    if (row.status === "refunded") event = `${row.phase}: refunded`;
    else if (row.firstAttendedWeek == null) event = `${row.phase}: registered, never attended`;
    else if (row.status === "late_joiner") event = `${row.phase}: first joined week ${row.firstJoinedWeek} · late joiner, should restart next batch`;
    else if (row.status === "moved") event = `${row.phase}: first joined week ${row.firstJoinedWeek} · moved to next batch`;
    else event = `${row.phase}: attended ${row.weeksAttended} of ${row.heldWeeks} weeks`;
    return { batch: fmtShortDate(batch.startDate), event, date: batch.startDate };
  });
  if (learner.paymentDate) batchHistory.unshift({ batch: "Payment", event: `Paid via ${learner.platform || "TagMango"}${learner.status === "refunded" ? " · refunded" : ""}`, date: learner.paymentDate });
  timelines.sort((a, b) => b.date.localeCompare(a.date) || b.startTime.localeCompare(a.startTime));
  return {
    ...base,
    inBatch: !!(chosen && chosen.batch.id === Number(batchId)),
    shownBatchId: chosen?.batch.id ?? null,
    sessionTimelines: timelines.slice(0, 8),
    batchHistory,
    linkedZoomNames: [...linked.values()]
  };
}

// ---------- Sync status & alerts ----------
export async function syncSources() {
  const accounts = loadZoomAccounts();
  const runs = await q(
    `SELECT DISTINCT ON (source) source, status, started_at, finished_at, records, note, error
       FROM sync_runs ORDER BY source, started_at DESC`);
  const bySource = new Map(runs.map(r => [r.source, r]));
  const interval = Number(process.env.SYNC_INTERVAL_MINUTES || 60);
  const nextRun = globalThis.__fgNextSyncAt ? new Date(globalThis.__fgNextSyncAt).toISOString() : null;
  const sources = accounts.map(a => {
    const r = bySource.get(a.label);
    return {
      id: a.key, name: a.label, account: a.label, type: "Zoom meetings, participants & registrants", connected: a.connected,
      status: !a.connected ? "Not connected" : r ? (r.status === "running" ? "Running" : r.status) : "Never synced",
      lastSyncIso: r?.finished_at ? new Date(r.finished_at).toISOString() : null,
      recordsPulled: r?.records ?? 0, nextRunIso: a.connected ? nextRun : null, errorMsg: r?.error || "",
      intervalMinutes: interval
    };
  });
  const tm = await q1(`SELECT count(*)::int AS n, max(updated_at) AS last FROM learners`);
  const lastEvent = await q1(`SELECT max(received_at) AS last FROM tagmango_events`);
  const tmRun = bySource.get("TagMango");
  sources.push({
    id: "tagmango", name: "TagMango", account: `${tm.n} paid learners`, type: process.env.TAGMANGO_API_KEY && process.env.TAGMANGO_HOST ? "Subscribers API (recent on every sync, full refresh daily)" : "Order & refund webhooks · CSV import",
    connected: !!(process.env.TAGMANGO_API_KEY && process.env.TAGMANGO_HOST) || tm.n > 0,
    status: tmRun?.status || (tm.n > 0 ? "Synced" : "Never synced"),
    lastSyncIso: (lastEvent?.last || tm.last) ? new Date(lastEvent?.last || tm.last).toISOString() : null,
    recordsPulled: tm.n, nextRunIso: null, errorMsg: tmRun?.error || ""
  });
  return sources;
}

export async function alerts(batchId) {
  const out = [];
  const sources = await syncSources();
  const c = await loadCommon();
  const usedAccounts = new Set((await q(`SELECT DISTINCT zoom_account FROM batch_meetings`)).map(r => r.zoom_account));
  for (const s of sources) {
    if (s.id === "tagmango") continue;
    if (s.status === "Sync failed") out.push({ id: `sync-${s.id}`, severity: "red", title: `${s.name} sync failed`, detail: s.errorMsg || "See the sync log.", actionLabel: "Open Sync", actionHash: "#/sync" });
    else if (!s.connected && usedAccounts.has(s.id)) out.push({ id: `conn-${s.id}`, severity: "amber", title: `${s.name} is not connected`, detail: "Add its Zoom Server-to-Server OAuth credentials so its sessions can be pulled.", actionLabel: "Open Sync", actionHash: "#/sync" });
  }
  if (!c.learners.length) out.push({ id: "no-learners", severity: "amber", title: "No paid learners loaded yet", detail: "Import the TagMango buyers CSV or connect the TagMango webhook, otherwise nobody can be matched.", actionLabel: "Open Sync", actionHash: "#/sync" });
  if (batchId) {
    const m = await modelFor(batchId);
    if (m) {
      const stale = m.sessions.filter(s => s.status === "Awaiting data" && s.date < addDays(c.today, -1));
      if (stale.length) out.push({ id: "stale", severity: "amber", title: `${stale.length} past session${stale.length > 1 ? "s have" : " has"} no Zoom data yet`, detail: `Oldest: ${stale[0].type} on ${fmtShortDate(stale[0].date)} (${stale[0].phase}). Check the meeting ID in Settings or run a sync.`, actionLabel: "Open Sessions", actionHash: "#/sessions" });
      for (const [key, label] of [["p1", "Phase 1"], ["p2", "Phase 2"]]) {
        const w = m.batch.phaseSummary.All[key].weeklySundayAttended;
        const held = w.map((v, i) => [v, i]).filter(([v]) => v != null);
        if (held.length >= 2) {
          const [[a, ia], [b, ib]] = held.slice(-2);
          if (a > 0 && b < a * 0.85) {
            const off = key === "p2" ? WEEKS : 0;
            out.push({ id: `dip-${key}`, severity: "amber", title: `${label} Sunday attendance down ${Math.round((1 - b / a) * 100)}%`, detail: `Week ${ib + 1 + off}: ${b} attended vs ${a} in week ${ia + 1 + off}.`, actionLabel: "Open Sessions", actionHash: "#/sessions" });
          }
        }
      }
      const unmatched = (await reviewItems(batchId)).length;
      if (unmatched) out.push({ id: "unmatched", severity: "amber", title: `${unmatched} Zoom participant${unmatched > 1 ? "s" : ""} not matched to a paid learner`, detail: "Confirm matches by hand in the review queue; confirmed matches are remembered.", actionLabel: "Review Queue", actionHash: "#/review" });
    }
  }
  return out;
}

export async function syncLogs(limit = 50) {
  const rows = await q(`SELECT id, source, status, started_at, finished_at, records, note, error FROM sync_runs ORDER BY started_at DESC LIMIT $1`, [limit]);
  return rows.map(r => ({
    id: r.id, time: new Date(r.started_at).toISOString(), source: r.source, status: r.status, records: r.records,
    durationSec: r.finished_at ? Math.round((new Date(r.finished_at) - new Date(r.started_at)) / 100) / 10 : null,
    note: r.note || "", error: r.error || ""
  }));
}

export async function lastSyncedIso() {
  const r = await q1(`SELECT max(finished_at) AS t FROM sync_runs WHERE status IN ('Synced','Partial')`);
  return r?.t ? new Date(r.t).toISOString() : null;
}

export async function today() {
  return (await loadCommon()).today;
}
