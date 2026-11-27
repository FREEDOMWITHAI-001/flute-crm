import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchModel, buildJourney, batchCalendar, teachingWeekOf } from "../server/model.js";

// Two consecutive batches. Group A starts 6 Dec (weeks 1–7 = A Phase 1) and does weeks 8–14 in batch B (B Phase 2).
// Sunday learning P1 at 19:00 IST (13:30Z), P2 at 21:00 IST (15:30Z); practice P1 Tue 19:30 IST (14:00Z).
const A = { id: 1, name: "A", startDate: "2026-12-06" };
const B = { id: 2, name: "B", startDate: "2027-01-24" };
const addDays = (d, n) => new Date(Date.parse(d + "T00:00:00Z") + n * 864e5).toISOString().slice(0, 10);
const sunday = (batch, w) => addDays(batch.startDate, (w - 1) * 7);
const meetingsA = [
  { id: 10, slot: "learning_p1", zoomAccount: "zoom1", meetingId: "A1", startTime: "19:00", durationMin: 90 },
  { id: 11, slot: "practice_p1", zoomAccount: "zoom1", meetingId: "A2", startTime: "19:30", durationMin: 60 }
];
const meetingsB = [
  { id: 20, slot: "learning_p1", zoomAccount: "zoom1", meetingId: "B1", startTime: "19:00", durationMin: 90 },
  { id: 21, slot: "learning_p2", zoomAccount: "zoom1", meetingId: "B3", startTime: "21:00", durationMin: 90 }
];
const learners = [
  { id: 1, name: "Complete Chitra", email: "c1@x.in", phone: "+91 98200 00001", status: "paid" },
  { id: 2, name: "Stopper Sunil", email: "c2@x.in", phone: "+91 98200 00002", status: "paid" },
  { id: 3, name: "Dropper Deepa", email: "c3@x.in", phone: "+91 98200 00003", status: "paid" },
  { id: 4, name: "Restart Ravi", email: "c4@x.in", phone: "+91 98200 00004", status: "paid" },
  { id: 5, name: "Latestart Lata", email: "c5@x.in", phone: "+91 98200 00005", status: "paid" },
  { id: 6, name: "Refund Rohan", email: "c6@x.in", phone: "+91 98200 00006", status: "refunded" },
  { id: 7, name: "Practice Priya", email: "c7@x.in", phone: "+91 98200 00007", status: "paid" },
  { id: 8, name: "Newbie Neha", email: "c8@x.in", phone: "+91 98200 00008", status: "paid" } // only in B's Phase 1
];
// Who attends which Sundays (full 90 min); weeks 1–7 in A Phase 1, 8–14 in B Phase 2
const plan = {
  "c1@x.in": { a: [1, 2, 3, 4, 5, 6, 7], b2: [8, 9, 10, 11, 12, 13, 14] },
  "c2@x.in": { a: [1, 2, 3, 4, 5, 6, 7], b2: [8, 9, 10] },
  "c3@x.in": { a: [1, 2, 3, 4, 5, 6, 7], b2: [] },
  "c4@x.in": { a: [1, 2], b1: [1, 2, 3] },          // stopped, then restarted with the next group
  "c5@x.in": { a: [3, 4, 5, 6, 7], b2: [8, 9, 10, 11, 12, 13, 14] },
  "c6@x.in": { a: [1, 2, 3, 4, 5, 6, 7], b2: [8, 9, 10, 11, 12, 13, 14] },
  "c7@x.in": { a: [], aTue: [1, 2], b2: [] },        // only practice sessions
  "c8@x.in": { b1: [1, 2, 3] }
};
const at = (date, hhmm) => `${date}T${hhmm}:00Z`;
function fixtures() {
  const instA = [], instB = [], rowsA = [], rowsB = [];
  for (let w = 1; w <= 7; w++) {
    instA.push({ uuid: `A-sun-${w}`, batchMeetingId: 10, startTime: at(sunday(A, w), "13:30"), endTime: at(sunday(A, w), "15:00") });
    instA.push({ uuid: `A-tue-${w}`, batchMeetingId: 11, startTime: at(addDays(sunday(A, w), 2), "14:00"), endTime: at(addDays(sunday(A, w), 2), "15:00") });
    instB.push({ uuid: `B-p1-${w}`, batchMeetingId: 20, startTime: at(sunday(B, w), "13:30"), endTime: at(sunday(B, w), "15:00") });
    instB.push({ uuid: `B-p2-${w}`, batchMeetingId: 21, startTime: at(sunday(B, w), "15:30"), endTime: at(sunday(B, w), "17:00") });
  }
  for (const [email, p] of Object.entries(plan)) {
    const name = learners.find(l => l.email === email).name;
    for (const w of p.a || []) rowsA.push({ instanceUuid: `A-sun-${w}`, name, email, joinTime: at(sunday(A, w), "13:30"), leaveTime: at(sunday(A, w), "15:00") });
    for (const w of p.aTue || []) rowsA.push({ instanceUuid: `A-tue-${w}`, name, email, joinTime: at(addDays(sunday(A, w), 2), "14:00"), leaveTime: at(addDays(sunday(A, w), 2), "15:00") });
    for (const w of p.b1 || []) rowsB.push({ instanceUuid: `B-p1-${w}`, name, email, joinTime: at(sunday(B, w), "13:30"), leaveTime: at(sunday(B, w), "15:00") });
    for (const w of p.b2 || []) rowsB.push({ instanceUuid: `B-p2-${w - 7}`, name, email, joinTime: at(sunday(B, w - 7), "15:30"), leaveTime: at(sunday(B, w - 7), "17:00") });
  }
  return { instA, instB, rowsA, rowsB };
}
function journey(today = "2027-03-20", rules = {}, opts = {}) {
  const { instA, instB, rowsA, rowsB } = fixtures();
  const base = { links: new Map(), dnc: new Set(), learners, registrants: [], rules, today };
  const a = buildBatchModel({ ...base, batch: A, meetings: meetingsA, instances: instA.filter(i => i.startTime.slice(0, 10) <= today), rows: rowsA });
  const b = opts.noNext ? null : buildBatchModel({ ...base, batch: B, meetings: meetingsB, instances: instB.filter(i => i.startTime.slice(0, 10) <= today), rows: rowsB });
  return buildJourney(a, b, rules);
}
const byName = (j, n) => j.learners.find(l => l.name === n);

test("journey: a learner who attends all 14 weeks is Completed with 14/14", () => {
  const l = byName(journey(), "Complete Chitra");
  assert.equal(l.stage, "Completed");
  assert.equal(l.weeksAttended, 14);
  assert.equal(l.weeksHeld, 14);
  assert.equal(l.weeks.length, 14);
  assert.deepEqual(l.weeks.map(w => w.label), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
});

test("journey: stopping during weeks 8–14 (after Phase 2 ended) is 'Stopped in Phase 2'", () => {
  const l = byName(journey(), "Stopper Sunil");
  assert.equal(l.stage, "Stopped in Phase 2");
  assert.equal(l.weeksAttended, 10);
  assert.equal(l.reachedW7, true);
  assert.equal(l.joinedPhase2, true);
  assert.equal(l.reachedW14, false);
});

test("journey: finishing Phase 1 but never coming to Phase 2 is 'Did not continue'", () => {
  const l = byName(journey(), "Dropper Deepa");
  assert.equal(l.stage, "Did not continue");
  assert.equal(l.joinedPhase2, false);
});

test("journey: stopping and starting again with the next group is 'Restarted next batch'", () => {
  assert.equal(byName(journey(), "Restart Ravi").stage, "Restarted next batch");
});

test("journey: a late starter (first came week 3) who reaches week 14 still counts as completed, flagged late", () => {
  const j = journey();
  const l = byName(j, "Latestart Lata");
  assert.equal(l.stage, "Completed");
  assert.equal(l.startedW1, false);
  assert.equal(l.lateStart, true);
  assert.equal(j.funnel.completedLateStart, 1);
});

test("journey: refunded learners are never in the group", () => {
  assert.equal(byName(journey(), "Refund Rohan"), undefined);
});

test("journey: someone who only joined the NEXT group is not part of this group's journey", () => {
  assert.equal(byName(journey(), "Newbie Neha"), undefined);
});

test("journey: practice sessions count toward an attended week (default rules)", () => {
  const l = byName(journey(), "Practice Priya");
  assert.equal(l.weeks[0].status, "attended");
  assert.equal(l.weeksAttended, 2);
});

test("journey: practice-only weeks don't count when only Sunday is a counted session type", () => {
  const l = byName(journey("2027-03-20", { attendedSessionTypes: ["Sunday Learning"] }), "Practice Priya");
  assert.equal(l.weeksAttended, 0);
});

test("journey: funnel follows week-1 starters and never goes up", () => {
  const f = journey().funnel;
  // starters: Chitra, Sunil, Deepa, Ravi (Priya came to Tue week 1 → also a starter under default rules)
  assert.equal(f.startedW1, 5);
  assert.equal(f.reachedW7, 3);        // Chitra, Sunil, Deepa
  assert.equal(f.joinedPhase2, 2);     // Chitra, Sunil
  assert.equal(f.reachedW14, 1);       // Chitra
  assert.equal(f.completedAll, 2);     // + Lata (late start)
  assert.ok(f.startedW1 >= f.reachedW7 && f.reachedW7 >= f.joinedPhase2 && f.joinedPhase2 >= f.reachedW14);
});

test("journey: weekly attended counts per week across all 14 weeks", () => {
  const w = journey().weeklyAttended;
  assert.equal(w.length, 14);
  assert.equal(w[0], 5);  // Chitra, Sunil, Deepa, Ravi, Priya(Tue)
  assert.equal(w[2], 4);  // week 3: Chitra, Sunil, Deepa, Lata
  assert.equal(w[7], 3);  // week 8: Chitra, Sunil, Lata
  assert.equal(w[13], 2); // week 14: Chitra, Lata
});

test("journey: while the next batch is still running, people are 'In Phase 2' (not 'Stopped')", () => {
  const today = addDays(sunday(B, 3), 1); // B week 3 → group A in week 10
  const j = journey(today);
  assert.equal(byName(j, "Stopper Sunil").stage, "In Phase 2");
  assert.equal(byName(j, "Complete Chitra").stage, "In Phase 2");
  assert.equal(j.weeklyAttended[13], null); // week 14 not held yet
  assert.equal(byName(j, "Complete Chitra").weeks[13].status, "upcoming");
});

test("journey: during Phase 1 everyone is 'In Phase 1' and weeks 8–14 are upcoming", () => {
  const j = journey(addDays(sunday(A, 4), 1), {}, { noNext: true });
  assert.ok(j.learners.every(l => l.stage === "In Phase 1"));
  assert.equal(j.cohort.phase2Status, "Not set up");
  assert.ok(j.learners.every(l => l.weeks.slice(7).every(w => w.status === "upcoming")));
});

test("journey: no learner is listed twice and every strip has exactly 14 weeks", () => {
  const j = journey();
  assert.equal(new Set(j.learners.map(l => l.id)).size, j.learners.length);
  assert.ok(j.learners.every(l => l.weeks.length === 14 && l.weeksAttended <= l.weeksHeld));
  assert.equal(Object.values(j.stages).reduce((t, n) => t + n, 0), j.learners.length);
});

test("journey: a 19-minute week is 'partial', not attended", () => {
  const { instA, instB, rowsA, rowsB } = fixtures();
  rowsA.push({ instanceUuid: "A-sun-1", name: "Newbie Neha", email: "c8@x.in", joinTime: at(sunday(A, 1), "13:30"), leaveTime: at(sunday(A, 1), "13:49") });
  const base = { links: new Map(), dnc: new Set(), learners, registrants: [], rules: {}, today: "2027-03-20" };
  const a = buildBatchModel({ ...base, batch: A, meetings: meetingsA, instances: instA, rows: rowsA });
  const b = buildBatchModel({ ...base, batch: B, meetings: meetingsB, instances: instB, rows: rowsB });
  const neha = buildJourney(a, b, {}).learners.find(l => l.name === "Newbie Neha");
  assert.equal(neha.weeks[0].status, "partial");
  assert.equal(neha.startedW1, false);
});

test("calendar: no breaks = 7 consecutive Sundays; two breaks stretch the window by two weeks", () => {
  assert.equal(batchCalendar({ startDate: "2026-12-06" }).lastDay, "2027-01-23");
  const cal = batchCalendar({ startDate: "2026-12-06", breakWeeks: ["2026-12-27", "2027-01-03"] });
  assert.equal(cal.sundays.length, 7);
  assert.equal(cal.lastDay, "2027-02-06");
  assert.equal(teachingWeekOf(cal, "2027-01-10"), 4);
  assert.equal(teachingWeekOf(cal, "2026-12-29"), 3); // inside the first break → make-up for week 3
});

test("calendar: a break listed before the start date, or on the start date, is ignored", () => {
  const cal = batchCalendar({ startDate: "2026-12-06", breakWeeks: ["2026-11-29", "2026-12-06"] });
  assert.deepEqual(cal.breaks, []);
  assert.equal(cal.sundays[0], "2026-12-06");
});

test("journey: each of the 14 weeks has its Sunday date (8–14 from the next batch)", () => {
  const j = journey();
  assert.equal(j.weekDates.length, 14);
  assert.equal(j.weekDates[0], "2026-12-06");
  assert.equal(j.weekDates[6], "2027-01-17");
  assert.equal(j.weekDates[7], "2027-01-24"); // = next batch start
  assert.equal(j.weekDates[13], "2027-03-07");
  assert.equal(j.weekDatesPlanned, false);
  const solo = journey("2026-12-30", {}, { noNext: true });
  assert.equal(solo.weekDates[7], "2027-01-24"); // estimated: the Sunday after week 7
  assert.equal(solo.weekDatesPlanned, true);
});
