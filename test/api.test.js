// End-to-end: real HTTP server + in-memory Postgres, seeded the way a Zoom sync and a CSV import would.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { initDb, q, q1, insertMany, db } from "../server/db.js";
import { ensureFirstAdmin } from "../server/auth.js";
import { createApp } from "../server/index.js";
import { invalidate } from "../server/store.js";

let server, base, cookie = "";

async function call(method, path, body, { asCookie = cookie } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json", ...(asCookie ? { Cookie: asCookie } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json, headers: res.headers };
}

async function loginAs(email, password) {
  const r = await call("POST", "/api/auth/login", { email, password }, { asCookie: "" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return r.headers.get("set-cookie").split(";")[0];
}

before(async () => {
  process.env.ZOOM_1_LABEL = "connect@daveharsh.com";
  process.env.TAGMANGO_WEBHOOK_SECRET = "s3cret-value";
  process.env.PUBLIC_URL = "https://crm.example.com";
  await initDb({ dataDir: ":memory:" });
  await ensureFirstAdmin({ ADMIN_EMAIL: "harsh@example.com", ADMIN_PASSWORD: "admin-pass-1", ADMIN_NAME: "Harsh" });
  server = createApp().listen(0);
  await new Promise(r => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  cookie = await loginAs("harsh@example.com", "admin-pass-1");
});

after(async () => {
  server?.close();
  await db().close();
});

test("auth: unauthenticated is 401, wrong password is 401", async () => {
  assert.equal((await call("GET", "/api/bootstrap", null, { asCookie: "" })).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { email: "harsh@example.com", password: "nope" }, { asCookie: "" })).status, 401);
});

test("empty system: bootstrap works with no batches", async () => {
  const r = await call("GET", "/api/bootstrap");
  assert.equal(r.status, 200);
  assert.equal(r.json.defaultBatchId, null);
  assert.deepEqual(r.json.batches, []);
  assert.ok(r.json.sync.alerts.some(a => a.id === "no-learners"));
});

test("full flow: import learners, create batch + meetings, Zoom data, analytics, review, lists", async () => {
  // Learners from a TagMango CSV export
  const csv = [
    "Customer Name,Email,Phone,Country,Payment Date,Status",
    "Asha Rao,asha@example.com,+91 9820000001,India,2026-12-01,Completed",
    "Bala Iyer,bala@example.com,9820000002,India,2026-12-02,Completed",
    "\"Nair, Chitra\",chitra@example.com,+1 415 555 0103,USA,2026-12-02,Refunded",
    "No Contact,,,India,2026-12-02,Completed"
  ].join("\n");
  const imp = await call("POST", "/api/learners/import", { csv });
  assert.equal(imp.status, 200);
  assert.deepEqual([imp.json.inserted, imp.json.updated, imp.json.skipped], [3, 0, 1]);

  // Batch must start on a Sunday
  assert.equal((await call("POST", "/api/batches", { startDate: "2026-12-07" })).status, 400);
  const b = await call("POST", "/api/batches", { startDate: "2026-12-06" });
  assert.equal(b.status, 200);
  const batchId = b.json.id;

  const m1 = await call("POST", `/api/batches/${batchId}/meetings`, { slot: "learning_p1", zoomAccount: "zoom1", ref: "842 9104 3312" });
  assert.equal(m1.status, 200, JSON.stringify(m1.json));
  const m2 = await call("POST", `/api/batches/${batchId}/meetings`, { slot: "learning_p2", zoomAccount: "zoom1", ref: "https://zoom.us/meeting/register/HqQytNqgSw6O8VmVLPKLOA" });
  assert.equal(m2.status, 200);
  assert.equal((await call("POST", `/api/batches/${batchId}/meetings`, { slot: "nope", zoomAccount: "zoom1", ref: "123" })).status, 400);
  const settings = await call("GET", "/api/settings");
  const mtgs = settings.json.batches[0].meetings;
  assert.equal(mtgs.find(m => m.slot === "learning_p1").meetingId, "84291043312");
  assert.ok(mtgs.find(m => m.slot === "learning_p2").registrationUrl.includes("/register/"));
  assert.ok(settings.json.tagmango.webhookUrl.includes("secret=s3cret-value"));

  // What a Zoom sync writes
  await q(`INSERT INTO zoom_instances (uuid, batch_meeting_id, meeting_id, zoom_account, start_time, end_time, report_synced_at)
           VALUES ('w1', $1, '84291043312', 'zoom1', '2026-12-06T13:30:00Z', '2026-12-06T15:00:00Z', now())`, [m1.json.id]);
  await insertMany(db(), "zoom_participants", ["instance_uuid", "name", "email", "registrant_id", "join_time", "leave_time"], [
    ["w1", "Asha Rao", "asha@example.com", null, "2026-12-06T13:30:00Z", "2026-12-06T15:00:00Z"],
    ["w1", "Bala phone", "", "rB", "2026-12-06T13:31:00Z", "2026-12-06T14:40:00Z"],
    ["w1", "Ravi's iPhone", "", null, "2026-12-06T13:35:00Z", "2026-12-06T14:30:00Z"]
  ]);
  await q(`INSERT INTO zoom_registrants (meeting_id, registrant_id, email, first_name, phone) VALUES
           ('84291043312', 'rA', 'asha@example.com', 'Asha', ''), ('84291043312', 'rB', 'b.other@gmail.com', 'Bala', '+919820000002')`);
  invalidate();

  const boot = await call("GET", "/api/bootstrap");
  assert.equal(boot.json.defaultBatchId, batchId);
  assert.equal(boot.json.unmatchedCount, 1);

  const ov = await call("GET", `/api/batches/${batchId}/overview`);
  assert.equal(ov.status, 200);
  const p1 = ov.json.batch.phaseSummary.All.p1;
  assert.equal(p1.w1Attended, 3);
  assert.equal(p1.registered, 2);
  assert.equal(p1.paid, 2);
  assert.equal(ov.json.batch.phaseSummary.India.p1.w1Attended, 2); // Ravi has no region

  const ses = await call("GET", `/api/batches/${batchId}/sessions`);
  const sun = ses.json.sessions.find(s => s.date === "2026-12-06" && s.slot === "learning_p1");
  assert.equal(sun.status, "Synced");
  const det = await call("GET", `/api/sessions/${encodeURIComponent(sun.id)}`);
  assert.equal(det.json.participants.length, 3);
  assert.equal(det.json.zoomAccountLabel, "connect@daveharsh.com");

  const ln = await call("GET", `/api/batches/${batchId}/learners`);
  assert.deepEqual(ln.json.learners.map(l => l.name).sort(), ["Asha Rao", "Bala Iyer"]);
  assert.equal(ln.json.learners.find(l => l.name === "Bala Iyer").matchMethod, "phone");

  // Review queue → match Ravi to Asha? No: mark him "not a learner", then he disappears from counts
  const rv = await call("GET", `/api/batches/${batchId}/review`);
  assert.equal(rv.json.items.length, 1);
  const item = rv.json.items[0];
  assert.equal(item.zoomName, "Ravi's iPhone");
  const search = await call("GET", "/api/learners/search?q=asha");
  assert.equal(search.json.results[0].name, "Asha Rao");
  assert.equal((await call("POST", "/api/review/resolve", { identityKey: item.id, action: "match", learnerId: search.json.results[0].id })).status, 200);
  const ov2 = await call("GET", `/api/batches/${batchId}/overview`);
  assert.equal(ov2.json.batch.phaseSummary.All.p1.w1Attended, 2); // Ravi's minutes now count as Asha's
  assert.equal((await call("GET", `/api/batches/${batchId}/review`)).json.items.length, 0);

  const prof = await call("GET", `/api/learners/${search.json.results[0].id}?batchId=${batchId}`);
  assert.equal(prof.status, 200);
  assert.ok(prof.json.linkedZoomNames.some(z => z.zoomName === "Ravi's iPhone"));
  assert.equal(prof.json.inBatch, true);

  // Do-not-contact + lists
  assert.equal((await call("POST", "/api/dnc", { values: "bala@example.com\n+91 98200 00009\nnot-valid" })).json.added, 2);
  const lists = await call("GET", `/api/batches/${batchId}/lists`);
  assert.equal(lists.json.dncExcludedCount, 1);
  assert.deepEqual(lists.json.doNotContact.map(r => r.name), ["Bala Iyer"]);

  // Rules
  const rules = await call("PUT", "/api/settings/rules", { rules: { attendedMinMinutes: 80 } });
  assert.equal(rules.json.rules.attendedMinMinutes, 80);
  assert.equal((await call("PUT", "/api/settings/rules", { rules: { attendedMinMinutes: "abc" } })).status, 400);
  const ov3 = await call("GET", `/api/batches/${batchId}/overview`);
  assert.equal(ov3.json.batch.phaseSummary.All.p1.w1Attended, 1); // only Asha stayed 80+ min
});

test("roles: viewer sees overview only, team member sees lists only", async () => {
  assert.equal((await call("POST", "/api/users", { name: "View Only", email: "viewer@example.com", role: "Viewer", password: "viewer-pass" })).status, 200);
  assert.equal((await call("POST", "/api/users", { name: "Caller", email: "team@example.com", role: "Team member", password: "team-pass-1" })).status, 200);
  assert.equal((await call("POST", "/api/users", { name: "Short", email: "short@example.com", role: "Viewer", password: "123" })).status, 400);
  const viewer = await loginAs("viewer@example.com", "viewer-pass");
  const team = await loginAs("team@example.com", "team-pass-1");
  const batchId = (await call("GET", "/api/bootstrap")).json.defaultBatchId;

  assert.equal((await call("GET", `/api/batches/${batchId}/overview`, null, { asCookie: viewer })).status, 200);
  assert.equal((await call("GET", `/api/batches/${batchId}/learners`, null, { asCookie: viewer })).status, 403);
  assert.equal((await call("GET", "/api/settings", null, { asCookie: viewer })).status, 403);
  assert.equal((await call("GET", `/api/batches/${batchId}/lists`, null, { asCookie: team })).status, 200);
  assert.equal((await call("GET", `/api/batches/${batchId}/overview`, null, { asCookie: team })).status, 403);
  assert.equal((await call("POST", "/api/sync/run", { source: "zoom" }, { asCookie: team })).status, 403);
  assert.equal((await call("GET", "/api/bootstrap", null, { asCookie: team })).json.unmatchedCount, 0);
});

test("TagMango webhook: secret required, order creates learner, refund marks refunded", async () => {
  const hook = (body, secret = "s3cret-value") => call("POST", `/api/webhooks/tagmango?secret=${secret}`, body, { asCookie: "" });
  assert.equal((await hook({ event: "order.created.completed" }, "wrong")).status, 401);
  const r = await hook({ event: "order.created.completed", data: { fan: { name: "Gita Menon", email: "Gita@Example.com", phone: "9820000077", country: "India" }, createdAt: "2026-12-03T10:00:00Z", mango: { title: "Flute Hackathon" } } });
  assert.equal(r.status, 200);
  assert.ok(r.json.learner);
  const l = await q1(`SELECT * FROM learners WHERE email = 'gita@example.com'`);
  assert.equal(l.name, "Gita Menon");
  assert.equal(l.status, "paid");
  await hook({ event: "order.refund.initiated", data: { fan: { email: "gita@example.com" } } });
  assert.equal((await q1(`SELECT status FROM learners WHERE email = 'gita@example.com'`)).status, "refunded");
});

test("sync run with no Zoom credentials skips cleanly", async () => {
  const r = await call("POST", "/api/sync/run", { source: "zoom" });
  assert.equal(r.status, 200);
  const sync = await call("GET", "/api/sync");
  assert.equal(sync.json.sources.find(s => s.id === "zoom1").status, "Not connected");
});
