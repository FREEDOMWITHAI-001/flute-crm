import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchModel, isStaffEmail } from "../server/model.js";
import { resolveIdentity, buildLearnerIndex, fixEmailTypos, fullNameKey, phoneKey, normPhone } from "../server/match.js";

// ---------- matching ----------
const L = [
  { id: 1, name: "Kumodini Jain", email: "kumodinimj@gmail.com", phone: "+91 99693 09580" },
  { id: 2, name: "Vinod Kumar", email: "v1@gmail.com", phone: "" },
  { id: 3, name: "Vinod Kumar", email: "v2@gmail.com", phone: "" },     // same full name twice → never auto-matched
  { id: 4, name: "Preeti", email: "preeti@gmail.com", phone: "" },      // single word → never auto-matched by name
  { id: 5, name: "Ajit Sawant", email: "drajitsawant@gmail.com", phone: "" }
];
const idx = buildLearnerIndex(L);
const none = new Map();

test("match: exact email wins", () => assert.equal(resolveIdentity({ name: "x", email: "KUMODINIMJ@gmail.com" }, idx, none).learnerId, 1));
test("match: common domain typos are fixed (gmsil, .con, .comm, gmai, hotmsil)", () => {
  assert.equal(fixEmailTypos("drajitsawant@gmsil.com"), "drajitsawant@gmail.com");
  assert.equal(fixEmailTypos("a@gmail.con"), "a@gmail.com");
  assert.equal(fixEmailTypos("a@gmail.comm"), "a@gmail.com");
  assert.equal(fixEmailTypos("a@gmai.com"), "a@gmail.com");
  assert.equal(fixEmailTypos("a@hotmsil.com"), "a@hotmail.com");
  assert.equal(resolveIdentity({ name: "x", email: "drajitsawant@gmsil.com" }, idx, none).learnerId, 5);
});
test("match: a real different domain is NOT 'fixed'", () => assert.equal(fixEmailTypos("a@gmx.com"), "a@gmx.com"));
test("match: unique full name matches when the email doesn't", () => {
  const r = resolveIdentity({ name: "kumodini  JAIN", email: "other@gmail.com" }, idx, none);
  assert.equal(r.learnerId, 1);
  assert.equal(r.via, "name");
});
test("match: a full name shared by two learners is never auto-matched", () =>
  assert.equal(resolveIdentity({ name: "Vinod Kumar", email: "x@y.com" }, idx, none).learnerId, null));
test("match: a single-word name is never auto-matched", () =>
  assert.equal(resolveIdentity({ name: "Preeti", email: "zz@y.com" }, idx, none).learnerId, null));
test("match: device words don't make a name ('Asha iPhone' ≠ 2 words)", () => assert.equal(fullNameKey("Preeti iPhone"), ""));
test("match: phone keys compare the last 10 digits", () => {
  assert.equal(phoneKey("+91 99693 09580"), phoneKey("09969309580"));
  assert.equal(normPhone("9969309580"), "919969309580");
});
test("match: a 'not a learner' decision excludes the person", () => {
  const links = new Map([["email:kumodinimj@gmail.com", { decision: "not_learner" }]]);
  assert.equal(resolveIdentity({ name: "x", email: "kumodinimj@gmail.com" }, idx, links).excluded, true);
});
test("staff: Flute Gandharvas' own logins are never attendees", () => {
  assert.equal(isStaffEmail("connect@daveharsh.com"), true);
  assert.equal(isStaffEmail("HD@DaveHarsh.com "), true);
  assert.equal(isStaffEmail("harsh@gmail.com"), false);
});

// ---------- call list ----------
// 5 Sundays held; each learner's pattern of attended Sundays (90 min) decides the list
const batch = { id: 9, name: "T", startDate: "2026-12-06" };
const meetings = [{ id: 1, slot: "learning_p1", zoomAccount: "zoom1", meetingId: "M", startTime: "19:00", durationMin: 90 }];
const sun = w => new Date(Date.parse("2026-12-06T00:00:00Z") + (w - 1) * 7 * 864e5).toISOString().slice(0, 10);
const pattern = {
  1: [1, 2, 3, 4, 5],   // active
  2: [1, 2, 3],         // missed last 2 → call
  3: [1, 2],            // missed last 3 → call
  4: [1],               // missed last 4 → dropped off, not call
  5: [1, 2, 3],         // missed last 2 but do-not-contact
  6: [1, 2, 3],         // missed last 2 but refunded
  7: [2, 3],            // late joiner (first came week 2) → own list, not call
  8: []                 // registered, never came → not "missed twice"
};
const callLearners = Object.keys(pattern).map(Number).map(id => ({ id, name: `L${id} Person`, email: `l${id}@t.in`, phone: `+91 9820000${String(id).padStart(3, "0")}`, status: id === 6 ? "refunded" : "paid" }));
function callModel(rules = {}) {
  const instances = [1, 2, 3, 4, 5].map(w => ({ uuid: `s${w}`, batchMeetingId: 1, startTime: `${sun(w)}T13:30:00Z`, endTime: `${sun(w)}T15:00:00Z` }));
  const rows = [];
  for (const [id, weeks] of Object.entries(pattern)) for (const w of weeks)
    rows.push({ instanceUuid: `s${w}`, name: `L${id} Person`, email: `l${id}@t.in`, joinTime: `${sun(w)}T13:30:00Z`, leaveTime: `${sun(w)}T15:00:00Z` });
  const registrants = [{ meetingId: "M", registrantId: "r8", email: "l8@t.in", firstName: "L8", lastName: "Person", phone: "" }];
  return buildBatchModel({ batch, meetings, instances, rows, registrants, learners: callLearners, links: new Map(),
    dnc: new Set(["email:l5@t.in"]), rules, today: "2027-01-08" });
}
test("call list: exactly the people who missed the last 2–3 Sundays after attending", () => {
  assert.deepEqual(callModel().lists.missedTwice.map(r => r.id).sort(), [2, 3]);
});
test("call list: 4+ misses go to 'Dropped off', never the call list", () => {
  const { lists } = callModel();
  assert.deepEqual(lists.droppedOff.map(r => r.id), [4]);
  assert.ok(!lists.missedTwice.some(r => r.id === 4));
});
test("call list: do-not-contact and refunded learners are excluded", () => {
  const ids = callModel().lists.missedTwice.map(r => r.id);
  assert.ok(!ids.includes(5) && !ids.includes(6));
});
test("call list: late joiners are excluded (they restart with the next batch)", () => {
  const { lists } = callModel();
  assert.ok(!lists.missedTwice.some(r => r.id === 7));
  assert.ok(lists.lateJoiners.some(r => r.id === 7));
});
test("call list: someone who never attended is not 'missed twice'", () => {
  assert.ok(!callModel().lists.missedTwice.some(r => r.id === 8));
});
test("call list: raising the threshold to 3 misses removes the 2-miss person", () => {
  assert.deepEqual(callModel({ missedTwiceCount: 3 }).lists.missedTwice.map(r => r.id), [3, 4]);
});
test("call list: a Sunday with no Zoom report is never counted as a miss", () => {
  // drop the week-5 report: person 2 then has only 1 trailing miss → not on the list
  const m = buildBatchModel({ ...(() => {
    const instances = [1, 2, 3, 4].map(w => ({ uuid: `s${w}`, batchMeetingId: 1, startTime: `${sun(w)}T13:30:00Z`, endTime: `${sun(w)}T15:00:00Z` }));
    const rows = [1, 2, 3].map(w => ({ instanceUuid: `s${w}`, name: "L2 Person", email: "l2@t.in", joinTime: `${sun(w)}T13:30:00Z`, leaveTime: `${sun(w)}T15:00:00Z` }));
    return { batch, meetings, instances, rows, registrants: [], learners: callLearners, links: new Map(), dnc: new Set(), rules: {}, today: "2027-01-08" };
  })() });
  assert.ok(!m.lists.missedTwice.some(r => r.id === 2));
});
test("percentages: no session or weekly figure is ever above 100%", () => {
  const m = callModel();
  for (const s of m.sessions) if (s.cohort) assert.ok(s.paidAttended <= s.cohort);
  for (const v of m.batch.phaseSummary.All.p1.sessionTypeRates.sunday) assert.ok(v == null || v <= 100);
  for (const [i, v] of m.batch.phaseSummary.All.p1.weeklyRetainedFromW1.entries()) if (v != null) assert.ok(v <= m.batch.phaseSummary.All.p1.w1Attended, `week ${i + 1}`);
});
