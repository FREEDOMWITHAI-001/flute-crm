// Pull Zoom data (past instances, participant reports, registrants) into Postgres.
import { db, q, q1, insertMany } from "./db.js";
import { ZoomClient, loadZoomAccounts } from "./zoom.js";
import { istDate, istTime, addDays, todayIst } from "./time.js";
import { batchCalendar } from "./model.js";

const DAY_MS = 86_400_000;
const LOOKBACK_DAYS = 70; // 14 weeks: a batch's meetings are still synced through Phase 2
const RECENT_REPORT_DAYS = 3; // Zoom keeps adding late leave rows for a while after a session

let running = false;

/**
 * Sync every connected Zoom account.
 * → [{ account, status, records, errors }] per connected account, or { skipped: true }
 *   when another sync is already running.
 */
export async function syncZoom({ accounts = loadZoomAccounts(), clientFactory = acct => new ZoomClient(acct), now = new Date(), log = console } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const results = [];
    for (const account of accounts) {
      if (!account.connected) continue;
      results.push(await syncAccount(account, clientFactory(account), now, log));
    }
    return results;
  } finally {
    running = false;
  }
}

async function syncAccount(account, client, now, log) {
  const run = await q1(`INSERT INTO sync_runs (source, status) VALUES ($1, 'running') RETURNING id`, [account.label]);
  const errors = [];
  let ok = 0; // successful Zoom steps, to tell "Partial" from "Sync failed"
  let records = 0;
  let sessions = 0;
  let meetingCount = 0;
  const fail = (what, e) => {
    const msg = `${what}: ${e.message || e}`;
    errors.push(msg);
    log.warn?.(`[sync ${account.key}] ${msg}`);
  };

  try {
    const today = todayIst(now);
    const meetings = await q(
      `SELECT bm.*, b.start_date, b.break_weeks
         FROM batch_meetings bm JOIN batches b ON b.id = bm.batch_id
        WHERE bm.zoom_account = $1
          AND ((b.start_date <= $2::date AND b.start_date >= $3::date)
               OR NOT EXISTS (SELECT 1 FROM zoom_instances zi JOIN batch_meetings bm2 ON bm2.id = zi.batch_meeting_id
                               WHERE bm2.batch_id = b.id))
        ORDER BY b.start_date, bm.id`,
      [account.key, addDays(today, 1), addDays(today, -LOOKBACK_DAYS)]
    );

    await resolveHosts(client, meetings, today);

    const instancesByMeeting = new Map(); // meeting_id -> promise of instances (fetched once per run)
    const meetingIds = new Set();
    const webinarIds = new Set(); // meetings Zoom turned out to run as webinars (no registrant access)
    // One Zoom link can serve two slots (old webinars ran Sun learning and Tue/Thu practice on the same ID):
    // then each occurrence goes to the slot that fits its weekday
    const slotsByBatchMeeting = new Map();
    for (const m of meetings) {
      const k = `${m.batch_id}:${m.meeting_id}`;
      slotsByBatchMeeting.set(k, (slotsByBatchMeeting.get(k) || 0) + 1);
    }
    const fitsSlot = (m, date) => {
      if ((slotsByBatchMeeting.get(`${m.batch_id}:${m.meeting_id}`) || 0) < 2) return true;
      const sunday = new Date(`${date}T12:00:00Z`).getUTCDay() === 0;
      return m.slot.startsWith("learning") ? sunday : !sunday;
    };

    for (const m of meetings) {
      // 1. Registration link → meeting ID
      if (!m.meeting_id && m.registration_url) {
        try {
          const found = await client.resolveRegistrationUrl(m.registration_url);
          if (!found) throw new Error("registration link not found in this Zoom account");
          m.meeting_id = found.meetingId;
          await q(
            `UPDATE batch_meetings SET meeting_id = $2, topic = $3, start_time = $4, duration_min = $5, resolve_error = NULL WHERE id = $1`,
            [m.id, found.meetingId, found.topic, found.startTime ? istTime(found.startTime) : null, found.durationMin]
          );
          ok++;
        } catch (e) {
          await q(`UPDATE batch_meetings SET resolve_error = $2 WHERE id = $1`, [m.id, e.message || String(e)]);
          fail(`Resolve ${m.registration_url}`, e);
          continue;
        }
      } else if (m.meeting_id && !m.topic) {
        try {
          const info = await client.getMeeting(m.meeting_id);
          await q(
            `UPDATE batch_meetings SET topic = $2, start_time = COALESCE($3, start_time), duration_min = COALESCE($4, duration_min) WHERE id = $1`,
            [m.id, info.topic || null, info.start_time ? istTime(info.start_time) : null, info.duration ?? null]
          );
        } catch {
          // Details are cosmetic; the sync itself does not need them.
        }
      }
      if (!m.meeting_id) continue;
      meetingCount++;
      meetingIds.add(m.meeting_id);

      // 2. Past instances inside this batch's 7-week window
      let instances;
      try {
        if (!instancesByMeeting.has(m.meeting_id)) instancesByMeeting.set(m.meeting_id, client.listPastInstances(m.meeting_id));
        instances = await instancesByMeeting.get(m.meeting_id);
        ok++;
      } catch (e) {
        fail(`Meeting ${m.meeting_id} instances`, e);
        continue;
      }
      let breaks = [];
      try { breaks = JSON.parse(m.break_weeks || "[]"); } catch { /* malformed → no breaks */ }
      const windowEnd = batchCalendar({ startDate: m.start_date, breakWeeks: breaks }).lastDay;
      for (const inst of instances) {
        if (!inst.uuid || !inst.start_time) continue;
        const date = istDate(inst.start_time);
        if (date < m.start_date || date > windowEnd) continue;
        if (!fitsSlot(m, date)) continue;
        sessions++;
        const row = await q1(
          `INSERT INTO zoom_instances (uuid, batch_meeting_id, meeting_id, zoom_account, start_time)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (uuid) DO UPDATE SET batch_meeting_id = EXCLUDED.batch_meeting_id, meeting_id = EXCLUDED.meeting_id,
             zoom_account = EXCLUDED.zoom_account, start_time = EXCLUDED.start_time
           RETURNING report_synced_at, report_error`,
          [inst.uuid, m.id, m.meeting_id, account.key, inst.start_time]
        );
        const recent = now.getTime() - new Date(inst.start_time).getTime() < RECENT_REPORT_DAYS * DAY_MS;
        if (row.report_synced_at && !recent && !row.report_error) continue;

        // 3. Participant report — one bad instance must not stop the rest
        try {
          records += await pullReport(client, inst.uuid, now, webinarIds, m.meeting_id);
          ok++;
        } catch (e) {
          await q(`UPDATE zoom_instances SET report_error = $2 WHERE uuid = $1`, [inst.uuid, e.message || String(e)]);
          fail(`Report ${inst.uuid} (${date})`, e);
        }
      }
    }

    // 4. Registrants, replaced wholesale per meeting
    for (const meetingId of meetingIds) {
      if (webinarIds.has(meetingId)) continue; // webinar registrants need a scope this app doesn't have
      try {
        const regs = await client.listRegistrants(meetingId);
        const byId = new Map();
        for (const r of regs) if (r.id) byId.set(r.id, r);
        await db().tx(async t => {
          await t.query(`DELETE FROM zoom_registrants WHERE meeting_id = $1`, [meetingId]);
          await insertMany(t, "zoom_registrants",
            ["meeting_id", "registrant_id", "email", "first_name", "last_name", "phone", "status", "create_time"],
            [...byId.values()].map(r => [meetingId, r.id, r.email || null, r.first_name || null, r.last_name || null,
              r.phone || null, r.status || null, r.create_time || null]));
        });
        ok++;
      } catch (e) {
        if (!isWebinarError(e)) fail(`Meeting ${meetingId} registrants`, e);
      }
    }
  } catch (e) {
    fail("Sync", e);
  }

  const status = !errors.length ? "Synced" : ok ? "Partial" : "Sync failed";
  const note = `${meetingCount} meeting${meetingCount === 1 ? "" : "s"} · ${sessions} session${sessions === 1 ? "" : "s"} · ${records.toLocaleString("en-US")} participant rows`;
  await q(
    `UPDATE sync_runs SET finished_at = now(), status = $2, records = $3, note = $4, error = $5 WHERE id = $1`,
    [run.id, status, records, note, errors[0] || null]
  );
  return { account: account.key, status, records, errors };
}

/** Re-pull one instance's participant report; returns the number of rows written. */
// Zoom answers meeting endpoints for a webinar with "Cannot access webinar info"
const isWebinarError = e => /webinar/i.test(e?.message || "");

async function pullReport(client, uuid, now, webinarIds, meetingId) {
  let report = {}, participants;
  try {
    report = await client.getMeetingReport(uuid);
    participants = await client.listReportParticipants(uuid);
  } catch (e) {
    if (!isWebinarError(e)) throw e;
    // Webinar: no summary report for this app, so the end time comes from the last leave time
    webinarIds?.add(meetingId);
    participants = await client.listWebinarReportParticipants(uuid);
    const leaves = participants.map(p => p.leave_time).filter(Boolean).sort();
    report = { end_time: leaves[leaves.length - 1] || null, participants_count: participants.length };
  }
  const rows = participants.map(p => [
    uuid, p.user_id || p.id || null, p.name || null, p.user_email || null, p.registrant_id || null,
    p.join_time || null, p.leave_time || null, p.duration ?? null
  ]);
  await db().tx(async t => {
    await t.query(`DELETE FROM zoom_participants WHERE instance_uuid = $1`, [uuid]);
    await insertMany(t, "zoom_participants",
      ["instance_uuid", "participant_id", "name", "email", "registrant_id", "join_time", "leave_time", "duration_sec"], rows);
    await t.query(
      `UPDATE zoom_instances SET end_time = $2, participants_count = $3, report_synced_at = $4, report_error = NULL WHERE uuid = $1`,
      [uuid, report.end_time || null, report.participants_count ?? null, now.toISOString()]
    );
  });
  return rows.length;
}

/**
 * Record which Zoom user (connect@ / hd@) hosts each link, once. Meetings carry host_email;
 * webinars refuse that call, so look them up in each user's usage report (last 90 days).
 */
async function resolveHosts(client, meetings, today) {
  const missing = meetings.filter(m => m.meeting_id && !m.host_email);
  if (!missing.length) return;
  const hosts = new Map();
  for (const m of missing) {
    if (hosts.has(m.meeting_id)) continue;
    try {
      const info = await client.getMeeting(m.meeting_id);
      if (info.host_email) hosts.set(m.meeting_id, info.host_email);
    } catch { /* webinar or deleted — try the usage report below */ }
  }
  if (missing.some(m => !hosts.has(m.meeting_id))) {
    try {
      const users = await client.listUsers();
      for (const u of users) {
        for (let back = 0; back < 90; back += 30) {
          const list = await client.paginate(`/report/users/${u.id}/meetings`,
            { from: addDays(today, -back - 29), to: addDays(today, -back), type: "past" }, "meetings");
          for (const x of list) if (!hosts.has(String(x.id))) hosts.set(String(x.id), u.email);
        }
      }
    } catch { /* needs report:read:user:admin; host stays blank */ }
  }
  for (const m of missing) {
    const h = hosts.get(m.meeting_id);
    if (!h) continue;
    m.host_email = h;
    await q(`UPDATE batch_meetings SET host_email = $2 WHERE id = $1`, [m.id, h]);
  }
}

/** Latest sync_runs row per source, for the UI. */
export async function getSyncState() {
  const rows = await q(`SELECT DISTINCT ON (source) * FROM sync_runs ORDER BY source, id DESC`);
  return rows.map(r => ({
    source: r.source,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    records: r.records,
    note: r.note,
    error: r.error
  }));
}

/** accountKey → error message, for accounts whose latest run failed or was partial. */
export async function lastErrorsByAccount(accounts = loadZoomAccounts()) {
  const byLabel = new Map((await getSyncState()).map(s => [s.source, s]));
  const out = new Map();
  for (const a of accounts) {
    const s = byLabel.get(a.label);
    if (s && (s.status === "Sync failed" || s.status === "Partial")) out.set(a.key, s.error || s.status);
  }
  return out;
}
