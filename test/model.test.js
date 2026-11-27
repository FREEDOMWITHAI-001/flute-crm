import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBatchModel, unionIntervals, sessionType, phase1Attendees, activeLearners } from "../server/model.js";
import { resolveIdentity, buildLearnerIndex, suggestLearners, normPhone, regionFor } from "../server/match.js";

// 6 Dec 2026 is a Sunday. Learning P1 at 19:00 IST = 13:30Z; practice at 19:30 IST = 14:00Z.
const at = (date, hhmmZ) => `${date}T${hhmmZ}:00Z`;
const batch = { id: 1, name: "Batch starting 6 Dec 2026", startDate: "2026-12-06" };
const meetings = [
  { id: 10, slot: "learning_p1", zoomAccount: "zoom1", meetingId: "111", startTime: "19:00", durationMin: 90 },
  { id: 11, slot: "practice_p1", zoomAccount: "zoom1", meetingId: "222", startTime: "19:30", durationMin: 60 },
  { id: 12, slot: "learning_p2", zoomAccount: "zoom2", meetingId: "333", startTime: "21:00", durationMin: 90 }
];
const learners = [
  { id: 1, name: "Asha Rao", email: "asha@example.com", phone: "+91 98200 00001", country: "India", status: "paid" },
  { id: 2, name: "Bala Iyer", email: "bala@example.com", phone: "98200 00002", country: "India", status: "paid" },
  { id: 3, name: "Chitra Nair", email: "chitra@example.com", phone: "+1 415 555 0103", country: "USA", status: "paid" },
  { id: 4, name: "Dev Kumar", email: "dev@example.com", phone: "+91 98200 00004", country: "India", status: "paid" },
  { id: 5, name: "Esha Paul", email: "esha@example.com", phone: "+91 98200 00005", country: "India", status: "refunded" },
  { id: 6, name: "Farah Khan", email: "farah@example.com", phone: "+91 98200 00006", country: "India", status: "paid" }
];
const instances = [
  { uuid: "w1sun", batchMeetingId: 10, startTime: at("2026-12-06", "13:30"), endTime: at("2026-12-06", "15:00") },
  { uuid: "w1tue", batchMeetingId: 11, startTime: at("2026-12-08", "14:00"), endTime: at("2026-12-08", "15:00") },
  { uuid: "w2sun", batchMeetingId: 10, startTime: at("2026-12-13", "13:30"), endTime: at("2026-12-13", "15:00") },
  { uuid: "w3sun", batchMeetingId: 10, startTime: at("2026-12-20", "13:30"), endTime: at("2026-12-20", "15:00") },
  { uuid: "p2w1", batchMeetingId: 12, startTime: at("2026-12-06", "15:30"), endTime: at("2026-12-06", "17:00") },
  { uuid: "old", batchMeetingId: 10, startTime: at("2026-11-29", "13:30"), endTime: at("2026-11-29", "15:00") } // before the batch
];
const row = (uuid, name, email, from, to, registrantId) => ({ instanceUuid: uuid, name, email, registrantId, joinTime: from, leaveTime: to });
const rows = [
  // Week 1 Sunday: Asha full, Bala via registrant phone (no email in Zoom), Chitra 10 min only, Esha (refunded) full
  row("w1sun", "Asha Rao", "asha@example.com", at("2026-12-06", "13:30"), at("2026-12-06", "14:00")),
  row("w1sun", "Asha iPad", "asha@example.com", at("2026-12-06", "13:50"), at("2026-12-06", "14:40")), // second device overlaps
  row("w1sun", "Bala", "", at("2026-12-06", "13:45"), at("2026-12-06", "15:00"), "regB"),
  row("w1sun", "Chitra", "chitra@example.com", at("2026-12-06", "13:30"), at("2026-12-06", "13:40")),
  row("w1sun", "Esha", "esha@example.com", at("2026-12-06", "13:30"), at("2026-12-06", "15:00")),
  row("w1sun", "Ravi's iPhone", "", at("2026-12-06", "13:35"), at("2026-12-06", "14:30")),
  row("w1sun", "Host Mentor", "mentor@fg.com", at("2026-12-06", "13:25"), at("2026-12-06", "15:00")),
  // Tuesday practice
  row("w1tue", "Asha Rao", "asha@example.com", at("2026-12-08", "14:00"), at("2026-12-08", "14:45")),
  // Week 2 Sunday: Asha, Dev (first time → late joiner), Ravi again
  row("w2sun", "Asha Rao", "asha@example.com", at("2026-12-13", "13:30"), at("2026-12-13", "15:00")),
  row("w2sun", "Dev K", "dev@example.com", at("2026-12-13", "13:30"), at("2026-12-13", "14:30")),
  row("w2sun", "Ravi's iPhone", "", at("2026-12-13", "13:30"), at("2026-12-13", "14:00")),
  // Week 3 Sunday: Asha only
  row("w3sun", "Asha Rao", "asha@example.com", at("2026-12-20", "13:30"), at("2026-12-20", "15:00")),
  // Phase 2 week 1 (= week 8): Farah
  row("p2w1", "Farah", "farah@example.com", at("2026-12-06", "15:30"), at("2026-12-06", "17:00")),
  // Outside the batch window: must be ignored
  row("old", "Asha Rao", "asha@example.com", at("2026-11-29", "13:30"), at("2026-11-29", "15:00"))
];
const registrants = [
  { meetingId: "111", registrantId: "regA", email: "asha@example.com", firstName: "Asha", lastName: "Rao", phone: "" },
  { meetingId: "111", registrantId: "regB", email: "bala.other@gmail.com", firstName: "Bala", lastName: "", phone: "+91 98200 00002" },
  { meetingId: "111", registrantId: "regC", email: "chitra@example.com", firstName: "Chitra", lastName: "Nair", phone: "" },
  { meetingId: "111", registrantId: "regD", email: "dev@example.com", firstName: "Dev", lastName: "", phone: "" },
  { meetingId: "111", registrantId: "regG", email: "ghost@example.com", firstName: "Ghost", lastName: "", phone: "" },
  { meetingId: "333", registrantId: "regF", email: "farah@example.com", firstName: "Farah", lastName: "", phone: "" }
];
const links = new Map([["email:mentor@fg.com", { decision: "not_learner" }]]);

function build(extra = {}) {
  return buildBatchModel({
    batch, meetings, instances, rows, registrants, learners, links, dnc: new Set(["email:bala@example.com"]),
    rules: {}, today: "2026-12-21", ...extra
  });
}

test("unionIntervals merges overlapping devices and rejoins", () => {
  assert.deepEqual(unionIntervals([[0, 30], [20, 70], [80, 90]]), [[0, 70], [80, 90]]);
  assert.deepEqual(unionIntervals([[10, 5]]), []);
});

test("session types follow the slot and the IST weekday", () => {
  assert.equal(sessionType("learning_p1", "2026-12-06"), "Sunday Learning");
  assert.equal(sessionType("practice_p1", "2026-12-08"), "Tuesday Practice");
  assert.equal(sessionType("practice_p2", "2026-12-10"), "Thursday Q&A");
  assert.equal(sessionType("practice_p2", "2026-12-09"), "Extra Practice");
});

test("phone normalisation and region", () => {
  assert.equal(normPhone("098200 00002"), "919820000002");
  assert.equal(normPhone("+1 (415) 555-0103"), "14155550103");
  assert.equal(regionFor({ phone: "9820000002" }), "India");
  assert.equal(regionFor({ phone: "+44 7700 900412" }), "Overseas");
  assert.equal(regionFor({ country: "India" }), "India");
});

test("identity resolution: email, then registrant phone, manual link, exclusion", () => {
  const index = buildLearnerIndex(learners);
  assert.equal(resolveIdentity({ name: "x", email: "ASHA@example.com" }, index, new Map()).learnerId, 1);
  assert.equal(resolveIdentity({ name: "Bala", email: "", phone: "+91 98200 00002" }, index, new Map()).via, "phone");
  const manual = new Map([["name:ravi s iphone", { decision: "match", learnerId: 6 }]]);
  assert.equal(resolveIdentity({ name: "Ravi's iPhone" }, index, manual).learnerId, 6);
  assert.equal(resolveIdentity({ name: "Host", email: "mentor@fg.com" }, index, links).excluded, true);
});

test("sessions: week labels, expected sessions, out-of-window instances ignored", () => {
  const m = build();
  const sun1 = m.sessions.find(s => s.id === "1-learning_p1-2026-12-06");
  assert.equal(sun1.status, "Synced");
  assert.equal(sun1.week, 1);
  assert.equal(sun1.startTime, "19:00");
  assert.equal(sun1.durationMin, 90);
  assert.equal(m.sessions.some(s => s.date === "2026-11-29"), false);
  const p2 = m.sessions.find(s => s.id === "1-learning_p2-2026-12-06");
  assert.equal(p2.weekLabel, 8);
  const future = m.sessions.find(s => s.id === "1-learning_p1-2027-01-03");
  assert.equal(future.status, "Upcoming");
  const thu = m.sessions.find(s => s.id === "1-practice_p1-2026-12-10");
  assert.equal(thu.status, "Awaiting data");
  assert.equal(thu.type, "Thursday Q&A");
});

test("session metrics: union of devices, 20-minute rule, excluded host, registrants", () => {
  const d = build().sessionDetail.get("1-learning_p1-2026-12-06");
  const asha = d.participants.find(p => p.learnerId === 1);
  assert.equal(asha.totalMinutes, 70); // 0–30 and 20–70 overlap → 70 min, not 80
  assert.equal(asha.rejoins, 1);
  assert.equal(d.participants.some(p => p.zoomEmail === "mentor@fg.com"), false);
  assert.equal(d.joined, 5); // Asha, Bala, Chitra, Esha, Ravi
  assert.equal(d.attended, 4); // Chitra only 10 min
  assert.equal(d.registered, 5); // ghost registered too
  assert.equal(d.participants.find(p => p.learnerId === 2).firstJoinOffset, 15);
  assert.equal(d.pctLate, 20); // Bala joined at +15 of 5 joined
  assert.equal(d.peakConcurrent, 4); // Chitra leaves at +10 before Bala arrives at +15
});

test("learner statuses: active, late joiner, refunded, inactive, missed twice", () => {
  const m = build();
  const byId = id => m.learners.find(l => l.id === id && l.phase === "Phase 1");
  assert.equal(byId(1).status, "active");
  assert.equal(byId(1).weeksAttended, 3);
  assert.equal(byId(1).isRegular, true); // 70, 90, 90 minutes
  assert.equal(byId(4).status, "late_joiner");
  assert.equal(byId(4).firstAttendedWeek, 2);
  assert.equal(byId(5).status, "refunded");
  assert.equal(byId(3).status, "inactive"); // registered, only 10 min once
  assert.equal(byId(2).isMissedTwice, true); // attended week 1, missed weeks 2 and 3
  assert.equal(byId(2).status, "at_risk");
  assert.equal(byId(2).doNotContact, true);
  assert.equal(m.learners.find(l => l.id === 6).phase, "Phase 2");
  assert.equal(m.learners.find(l => l.id === 6).weeks[0].label, 8);
});

test("a short week-1 visit is not a late joiner, even if 20+ minutes only comes in week 2", () => {
  const extra = [
    row("w1sun", "Farah", "farah@example.com", at("2026-12-06", "13:30"), at("2026-12-06", "13:42")),
    row("w2sun", "Farah", "farah@example.com", at("2026-12-13", "13:30"), at("2026-12-13", "14:30"))
  ];
  const m = build({ rows: [...rows, ...extra] });
  const farah = m.learners.find(l => l.id === 6 && l.phase === "Phase 1");
  assert.equal(farah.firstJoinedWeek, 1);
  assert.equal(farah.firstAttendedWeek, 2);
  assert.notEqual(farah.status, "late_joiner");
});

test("moved: a late joiner who shows up in the next batch's phase 1", () => {
  const m = build({ nextBatchPhase1People: new Set(["learner:4"]) });
  assert.equal(m.learners.find(l => l.id === 4).status, "moved");
});

test("phase summary: weekly counts, new vs returning, regions, rates", () => {
  const p1 = build().batch.phaseSummary.All.p1;
  assert.deepEqual(p1.weeklySundayAttended, [4, 3, 1, null, null, null, null]);
  assert.deepEqual(p1.weeklyNewVsReturning.map(w => [w.newCount, w.returningCount]), [[4, 0], [1, 2], [0, 1]]);
  assert.equal(p1.w1Attended, 4);
  assert.equal(p1.currentWeek, 3);
  assert.equal(p1.registered, 5);
  assert.equal(p1.sessionTypeRates.sunday[0], 80);
  assert.equal(p1.lateJoiners, 1);
  const overseas = build().batch.phaseSummary.Overseas.p1;
  assert.deepEqual(overseas.weeklySundayAttended.slice(0, 3), [0, 0, 0]); // Chitra (US) never reached 20 min
  assert.equal(build().batch.phaseSummary.All.p2.weekOffset, 7);
});

test("lists: missed twice, diamond, not paid, DNC exclusion", () => {
  const { lists } = build();
  assert.deepEqual(lists.missedTwice.map(r => r.id), []); // Bala is the only one and is do-not-contact
  assert.equal(lists.dncExcludedCount, 1);
  assert.deepEqual(lists.diamondShowcase.map(r => r.id), [1]);
  assert.deepEqual(lists.lateJoiners.map(r => r.id), [4]);
  assert.equal(lists.notPaid.length, 1);
  assert.equal(lists.notPaid[0].zoomName, "Ravi's iPhone");
  assert.equal(lists.notPaid[0].sessionsSeen, 2);
});

test("helpers: phase1 attendees and active learners", () => {
  const m = build();
  assert.ok(phase1Attendees(m).has("learner:1"));
  assert.ok(!phase1Attendees(m).has("learner:3"));
  const active = activeLearners([m], { today: "2026-12-21", rules: { activeWindowDays: 7 } });
  assert.deepEqual(active.map(r => r.id).sort(), [1]); // only Asha attended in the last 7 days
});

test("review suggestions rank the closest name first", () => {
  const s = suggestLearners({ name: "Asha (Mobile)", email: "" }, learners);
  assert.equal(s[0].learnerId, 1);
  assert.equal(suggestLearners({ name: "Guest 23", email: "" }, learners).length, 0);
});
