import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { initDb, db, q, q1 } from "../server/db.js";
import { syncZoom, getSyncState, lastErrorsByAccount } from "../server/sync.js";

const NOW = new Date("2026-11-26T06:00:00Z"); // Thu 26 Nov 2026, 11:30 IST
const quiet = { warn() {}, log() {} };

const accounts = [
  { key: "zoom1", label: "Flute Zoom", accountId: "a", clientId: "b", clientSecret: "c", connected: true },
  { key: "zoom2", label: "Zoom account 2", accountId: "", clientId: "", clientSecret: "", connected: false }
];

/** Fake ZoomClient with canned data; `reportCalls` counts participant pulls per uuid. */
function fakeClient() {
  const reportCalls = new Map();
  const people = uuid => [
    { id: "x1", user_id: "16778240", name: "Asha", user_email: "asha@example.com", registrant_id: "r1",
      join_time: "2026-11-01T04:30:00Z", leave_time: "2026-11-01T05:30:00Z", duration: 3600 },
    { id: "x2", user_id: "", name: "Ravi", user_email: "", registrant_id: "",
      join_time: "2026-11-01T04:35:00Z", leave_time: "2026-11-01T05:00:00Z", duration: 1500, uuid }
  ];
  const instances = {
    100: [
      { uuid: "L-old", start_time: "2026-10-04T04:30:00Z" }, // previous cycle → ignored
      { uuid: "/L1==", start_time: "2026-11-01T04:30:00Z" },
      { uuid: "L-bad", start_time: "2026-11-08T04:30:00Z" },
      { uuid: "L-late", start_time: "2026-12-20T04:30:00Z" } // after day 48 → ignored
    ],
    200: [
      { uuid: "P1", start_time: "2026-11-03T13:30:00Z" },
      { uuid: "P-recent", start_time: "2026-11-24T13:30:00Z" }
    ],
    300: [{ uuid: "OLD1", start_time: "2026-06-07T04:30:00Z" }]
  };
  return {
    reportCalls,
    failBad: true,
    async resolveRegistrationUrl(url) {
      if (url.includes("TOKPRACTICE")) return { meetingId: "200", topic: "Practice P1", startTime: "2026-11-03T13:30:00Z", durationMin: 60 };
      return null;
    },
    async getMeeting(id) {
      return { id: Number(id), topic: `Meeting ${id}`, start_time: "2026-11-01T04:30:00Z", duration: 120 };
    },
    async listPastInstances(id) {
      return instances[id] || [];
    },
    async getMeetingReport(uuid) {
      if (uuid === "L-bad" && this.failBad) throw Object.assign(new Error("Zoom 404 /report/meetings/L-bad: Meeting does not exist"), { status: 404 });
      return { uuid, end_time: "2026-11-01T06:00:00Z", participants_count: 2 };
    },
    async listReportParticipants(uuid) {
      reportCalls.set(uuid, (reportCalls.get(uuid) || 0) + 1);
      return people(uuid);
    },
    async listRegistrants(id) {
      return [
        { id: "r1", email: "asha@example.com", first_name: "Asha", last_name: "K", phone: "+919800000000", status: "approved", create_time: "2026-10-20T10:00:00Z" },
        { id: `r-${id}`, email: `p${id}@example.com`, first_name: "P", last_name: "", status: "approved" }
      ];
    }
  };
}

let client;

before(async () => {
  await initDb({ url: "", dataDir: ":memory:" });
  const b = await q1(`INSERT INTO batches (name, start_date) VALUES ('Nov 2026', '2026-11-01') RETURNING id`);
  const old = await q1(`INSERT INTO batches (name, start_date) VALUES ('Jun 2026', '2026-06-07') RETURNING id`);
  await q(`INSERT INTO batch_meetings (batch_id, slot, zoom_account, meeting_id) VALUES ($1, 'learning_p1', 'zoom1', '100')`, [b.id]);
  await q(`INSERT INTO batch_meetings (batch_id, slot, zoom_account, registration_url) VALUES ($1, 'practice_p1', 'zoom1', 'https://zoom.us/meeting/register/TOKPRACTICE')`, [b.id]);
  await q(`INSERT INTO batch_meetings (batch_id, slot, zoom_account, registration_url) VALUES ($1, 'learning_p2', 'zoom1', 'https://zoom.us/meeting/register/NOPE')`, [b.id]);
  await q(`INSERT INTO batch_meetings (batch_id, slot, zoom_account, meeting_id) VALUES ($1, 'learning_p1', 'zoom1', '300')`, [old.id]);
  await q(`INSERT INTO batch_meetings (batch_id, slot, zoom_account, meeting_id) VALUES ($1, 'learning_p2', 'zoom2', '999')`, [b.id]);
  client = fakeClient();
});

after(async () => {
  await db().close();
});

test("full sync writes instances, participants, registrants and a sync_runs row", async () => {
  const results = await syncZoom({ accounts, clientFactory: () => client, now: NOW, log: quiet });
  assert.equal(results.length, 1, "unconnected account is skipped");
  const [r] = results;
  assert.equal(r.account, "zoom1");
  assert.equal(r.status, "Partial"); // bad registration link + bad instance
  assert.equal(r.records, 8); // 4 good instances × 2 participants
  assert.equal(r.errors.length, 2);

  const inst = await q(`SELECT uuid, report_synced_at, report_error, participants_count FROM zoom_instances ORDER BY uuid`);
  assert.deepEqual(inst.map(i => i.uuid), ["/L1==", "L-bad", "OLD1", "P-recent", "P1"]);
  assert.ok(!inst.find(i => i.uuid === "L-old"), "instance outside the batch window is ignored");
  const bad = inst.find(i => i.uuid === "L-bad");
  assert.equal(bad.report_synced_at, null);
  assert.match(bad.report_error, /Meeting does not exist/);
  assert.equal(inst.find(i => i.uuid === "P1").participants_count, 2);

  const parts = await q(`SELECT * FROM zoom_participants WHERE instance_uuid = '/L1==' ORDER BY name`);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].participant_id, "16778240");
  assert.equal(parts[0].email, "asha@example.com");
  assert.equal(parts[0].registrant_id, "r1");
  assert.equal(parts[0].duration_sec, 3600);
  assert.equal(parts[1].participant_id, "x2"); // falls back to id when user_id is empty
  assert.equal(parts[1].email, null);

  const resolved = await q1(`SELECT * FROM batch_meetings WHERE registration_url LIKE '%TOKPRACTICE'`);
  assert.equal(resolved.meeting_id, "200");
  assert.equal(resolved.topic, "Practice P1");
  assert.equal(resolved.start_time, "19:00");
  assert.equal(resolved.duration_min, 60);
  const unresolved = await q1(`SELECT * FROM batch_meetings WHERE registration_url LIKE '%NOPE'`);
  assert.equal(unresolved.meeting_id, null);
  assert.match(unresolved.resolve_error, /not found/);
  const filled = await q1(`SELECT * FROM batch_meetings WHERE meeting_id = '100'`);
  assert.equal(filled.topic, "Meeting 100");
  assert.equal(filled.start_time, "10:00");

  const regs = await q(`SELECT meeting_id, registrant_id FROM zoom_registrants ORDER BY meeting_id, registrant_id`);
  assert.deepEqual(regs.map(x => `${x.meeting_id}:${x.registrant_id}`), ["100:r-100", "100:r1", "200:r-200", "200:r1", "300:r-300", "300:r1"]);

  const runs = await q(`SELECT * FROM sync_runs`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].source, "Flute Zoom");
  assert.equal(runs[0].status, "Partial");
  assert.equal(runs[0].records, 8);
  assert.equal(runs[0].note, "3 meetings · 5 sessions · 8 participant rows");
  assert.match(runs[0].error, /L-bad/);
  assert.ok(runs[0].finished_at);
});

test("re-sync replaces participant rows instead of duplicating them", async () => {
  client.failBad = false;
  client.reportCalls.clear();
  await q(`DELETE FROM batch_meetings WHERE registration_url LIKE '%NOPE'`);
  const [r] = await syncZoom({ accounts, clientFactory: () => client, now: NOW, log: quiet });
  assert.equal(r.status, "Synced");
  assert.deepEqual(r.errors, []);

  // Only the recent and the previously failed instances are re-pulled; the old batch is no longer "never synced".
  assert.deepEqual([...client.reportCalls.keys()].sort(), ["L-bad", "P-recent"]);
  const counts = await q(`SELECT instance_uuid, count(*)::int AS n FROM zoom_participants GROUP BY instance_uuid ORDER BY instance_uuid`);
  assert.deepEqual(counts.map(c => [c.instance_uuid, c.n]), [["/L1==", 2], ["L-bad", 2], ["OLD1", 2], ["P-recent", 2], ["P1", 2]]);
  const bad = await q1(`SELECT report_error, report_synced_at FROM zoom_instances WHERE uuid = 'L-bad'`);
  assert.equal(bad.report_error, null);
  assert.ok(bad.report_synced_at);
  assert.equal((await q(`SELECT 1 FROM zoom_registrants`)).length, 6); // meeting 300 rows untouched
});

test("sync state and last errors per account", async () => {
  const state = await getSyncState();
  assert.equal(state.length, 1);
  assert.equal(state[0].source, "Flute Zoom");
  assert.equal(state[0].status, "Synced");
  assert.equal((await lastErrorsByAccount(accounts)).size, 0);

  const failing = {
    async listPastInstances() { throw new Error("Zoom auth 400: Invalid client_id or client_secret"); },
    async listRegistrants() { throw new Error("Zoom auth 400: Invalid client_id or client_secret"); },
    async getMeeting() { throw new Error("nope"); }
  };
  const [r] = await syncZoom({ accounts, clientFactory: () => failing, now: NOW, log: quiet });
  assert.equal(r.status, "Sync failed");
  const errs = await lastErrorsByAccount(accounts);
  assert.match(errs.get("zoom1"), /Invalid client_id/);
});

test("a second concurrent sync is skipped", async () => {
  const slow = { ...fakeClient(), async listPastInstances() { await new Promise(r => setTimeout(r, 30)); return []; } };
  const first = syncZoom({ accounts, clientFactory: () => slow, now: NOW, log: quiet });
  const second = await syncZoom({ accounts, clientFactory: () => slow, now: NOW, log: quiet });
  assert.deepEqual(second, { skipped: true });
  assert.equal((await first).length, 1);
});
