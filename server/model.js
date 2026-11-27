// Pure analytics: Zoom join/leave rows + learners + rules  →  everything the dashboard shows.
// No I/O here, so every number on screen can be unit-tested from plain objects.
import { istDate, istTime, istInstant, weekday, addDays, daysBetween, fmtShortDate } from "./time.js";
import { buildLearnerIndex, resolveIdentity, normEmail, phoneKey, regionFor, normName, fullNameKey } from "./match.js";

export const SLOTS = {
  learning_p1: { phase: "Phase 1", kind: "learning", label: "Learning Session (Phase 1 · Straight)" },
  learning_p2: { phase: "Phase 2", kind: "learning", label: "Learning Session (Phase 2 · Side)" },
  practice_p1: { phase: "Phase 1", kind: "practice", label: "Practice & Q&A (Phase 1 · Tue + Thu)" },
  practice_p2: { phase: "Phase 2", kind: "practice", label: "Practice & Q&A (Phase 2 · Tue + Thu)" }
};
export const PHASES = ["Phase 1", "Phase 2"];
export const SESSION_TYPES = ["Sunday Learning", "Tuesday Practice", "Thursday Q&A"];
export const WEEKS = 7;
// Flute Gandharvas' own Zoom logins (host / co-host) — never counted as attendees
export const STAFF_EMAIL_DOMAINS = ["daveharsh.com"];
export const isStaffEmail = email => STAFF_EMAIL_DOMAINS.some(d => String(email || "").trim().toLowerCase().endsWith("@" + d));
const REGIONS = ["All", "India", "Overseas"];

export const DEFAULT_RULES = {
  attendedMinMinutes: 20,
  lateThresholdMinutes: 10,
  leftEarlyMinutes: 15,
  regularStreakWeeks: 3,
  regularMinMinutes: 60,
  missedTwiceCount: 2,
  activeWindowDays: 14,
  attendedSessionTypes: ["Sunday Learning", "Tuesday Practice", "Thursday Q&A"],
  regularSessionTypes: ["Sunday Learning"],
  missedTwiceSessionTypes: ["Sunday Learning"]
};

/** Session type from the meeting slot and the IST weekday it ran on. */
export function sessionType(slot, dateStr) {
  const kind = SLOTS[slot]?.kind;
  const wd = weekday(dateStr);
  if (kind === "learning") return wd === 0 ? "Sunday Learning" : "Extra Learning";
  if (wd === 2) return "Tuesday Practice";
  if (wd === 4) return "Thursday Q&A";
  return "Extra Practice";
}

export function weekOf(batchStart, dateStr) {
  return Math.floor(daysBetween(batchStart, dateStr) / 7) + 1;
}

/**
 * A batch's teaching calendar: 7 teaching Sundays from the start, skipping break Sundays (e.g. Diwali).
 * lastDay is the Saturday after the 7th teaching Sunday, so the window stretches by one week per break.
 */
export function batchCalendar(batch) {
  const breaks = new Set((batch.breakWeeks || []).filter(d => d > batch.startDate));
  const sundays = [];
  for (let d = batch.startDate, i = 0; sundays.length < WEEKS && i < 60; d = addDays(d, 7), i++) {
    if (!breaks.has(d)) sundays.push(d);
  }
  const lastDay = addDays(sundays[sundays.length - 1], 6);
  return { sundays, breaks: [...breaks].filter(b => b < lastDay).sort(), lastDay };
}

/** Teaching week (1–7) of a date, or null outside the batch. A session held in a break week is a make-up for the week before. */
export function teachingWeekOf(cal, dateStr) {
  if (dateStr < cal.sundays[0] || dateStr > cal.lastDay) return null;
  let w = null;
  for (let i = 0; i < cal.sundays.length; i++) if (cal.sundays[i] <= dateStr) w = i + 1;
  return w;
}

export function batchStatus(batch, today) {
  if (today < batch.startDate) return "Upcoming";
  if (today > batchCalendar(batch).lastDay) return "Completed";
  return "Active";
}

/** Merge overlapping [start, end] minute intervals (two devices, rejoins). */
export function unionIntervals(intervals) {
  const sorted = intervals.filter(([s, e]) => e > s).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 0.5) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const minutesBetween = (a, b) => (new Date(b) - new Date(a)) / 60_000;
const pct = (num, den) => (den ? Math.round((num / den) * 100) : null);
const mostCommon = arr => {
  const counts = new Map();
  for (const v of arr) if (v) counts.set(v, (counts.get(v) || 0) + 1);
  let best = "", n = 0;
  for (const [v, c] of counts) if (c > n) { best = v; n = c; }
  return best;
};

/**
 * Build the full model for one batch (a 7-week cycle: Phase 1 of the new cohort and
 * Phase 2 of the previous cohort run side by side).
 *
 * @param {object} input
 * @param {{id,name,startDate}} input.batch
 * @param {Array<{id,slot,zoomAccount,meetingId,startTime,durationMin}>} input.meetings  batch meetings
 * @param {Array<{uuid,batchMeetingId,startTime,endTime}>} input.instances  past Zoom instances
 * @param {Array<{instanceUuid,name,email,registrantId,joinTime,leaveTime}>} input.rows  participant rows
 * @param {Array<{meetingId,registrantId,email,firstName,lastName,phone}>} input.registrants
 * @param {Array<{id,name,email,phone,country,paymentDate,platform,status}>} input.learners
 * @param {Map<string,{decision,learnerId,decidedAt}>} input.links  manual review decisions
 * @param {Set<string>} input.dnc  "email:x" / "phone:last10"
 * @param {object} input.rules
 * @param {string} input.today  IST date
 * @param {Set<string>} [input.nextBatchPhase1People]  personKeys seen in the next batch's Phase 1
 * @param {Map<string,string>} [input.syncErrors]  zoomAccount -> error message
 */
export function buildBatchModel(input) {
  const { batch, meetings, instances, rows, registrants, learners, links, dnc, today } = input;
  const rules = { ...DEFAULT_RULES, ...(input.rules || {}) };
  const nextP1 = input.nextBatchPhase1People || new Set();
  const index = buildLearnerIndex(learners);
  const meetingById = new Map(meetings.map(m => [m.id, m]));
  const slotsConfigured = new Set(meetings.map(m => m.slot));

  // ---------- Registrants per slot (resolved to people) ----------
  const registrantById = new Map();
  // Registrations belong to ONE Zoom link. A session shows only the registrations of the link it ran on;
  // sessions on links without registration (the old webinars before 15 Nov) show none.
  const registeredByMeeting = new Map(); // zoom meeting id -> Map(personKey -> region)
  const registeredBySlot = new Map(); // slot -> Map(personKey -> region)
  for (const m of meetings) if (!registeredBySlot.has(m.slot)) registeredBySlot.set(m.slot, new Map());
  const meetingSlotsByZoomId = new Map();
  for (const m of meetings) {
    const k = String(m.meetingId || "").replace(/\s/g, "");
    if (!meetingSlotsByZoomId.has(k)) meetingSlotsByZoomId.set(k, []);
    meetingSlotsByZoomId.get(k).push(m.slot);
  }
  for (const r of registrants) {
    registrantById.set(r.registrantId, r);
    const name = [r.firstName, r.lastName].filter(Boolean).join(" ");
    const id = resolveIdentity({ name, email: r.email, phone: r.phone }, index, links);
    if (id.excluded) continue;
    const learner = id.learnerId ? index.byId.get(id.learnerId) : null;
    const region = regionFor({ phone: learner?.phone || r.phone, country: learner?.country });
    const mk = String(r.meetingId).replace(/\s/g, "");
    if (!registeredByMeeting.has(mk)) registeredByMeeting.set(mk, new Map());
    registeredByMeeting.get(mk).set(id.personKey, region);
    for (const slot of meetingSlotsByZoomId.get(mk) || []) {
      registeredBySlot.get(slot)?.set(id.personKey, region);
    }
  }

  // ---------- Sessions: one per (slot, IST date); several Zoom instances on a day merge ----------
  const sessions = new Map();
  const sessionIdFor = (slot, date) => `${batch.id}-${slot}-${date}`;
  const cal = batchCalendar(batch);
  const instanceSession = new Map();
  for (const inst of instances) {
    const m = meetingById.get(inst.batchMeetingId);
    if (!m) continue;
    const date = istDate(inst.startTime);
    const week = teachingWeekOf(cal, date);
    if (week == null) continue; // belongs to another cycle
    const id = sessionIdFor(m.slot, date);
    let s = sessions.get(id);
    if (!s) {
      s = {
        id, batchId: batch.id, slot: m.slot, phase: SLOTS[m.slot].phase, week, date,
        day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(date)],
        type: sessionType(m.slot, date), zoomAccount: m.zoomAccount, meetingId: m.meetingId, hostEmail: m.hostEmail || null,
        startIso: inst.startTime, endIso: inst.endTime || null, hasData: true, instanceCount: 0, rowCount: 0,
        scheduledTime: m.startTime || null, scheduledDuration: m.durationMin || null
      };
      sessions.set(id, s);
    }
    s.instanceCount++;
    // A host test-start or quick restart (< 3 min) must not move the session's start or end
    const micro = inst.endTime && minutesBetween(inst.startTime, inst.endTime) < 3;
    if (!micro && s.onlyMicro !== false) { s.startIso = inst.startTime; s.endIso = inst.endTime || null; s.onlyMicro = false; }
    else if (!micro) {
      if (new Date(inst.startTime) < new Date(s.startIso)) s.startIso = inst.startTime;
      if (inst.endTime && (!s.endIso || new Date(inst.endTime) > new Date(s.endIso))) s.endIso = inst.endTime;
    } else if (s.onlyMicro !== false) {
      s.onlyMicro = true;
      if (new Date(inst.startTime) < new Date(s.startIso)) s.startIso = inst.startTime;
      if (inst.endTime && (!s.endIso || new Date(inst.endTime) > new Date(s.endIso))) s.endIso = inst.endTime;
    }
    instanceSession.set(inst.uuid, s);
  }

  // Expected-but-missing sessions (future ones and ones Zoom hasn't returned yet).
  // Skip a slot/week/type that already ran on another date (e.g. a make-up held in a break week).
  const heldKey = new Set([...sessions.values()].map(s => `${s.slot}|${s.week}|${s.type}`));
  for (const m of meetings) {
    for (let w = 1; w <= WEEKS; w++) {
      const offsets = SLOTS[m.slot].kind === "learning" ? [0] : [2, 4];
      for (const off of offsets) {
        const date = addDays(cal.sundays[w - 1], off);
        const id = sessionIdFor(m.slot, date);
        if (sessions.has(id) || heldKey.has(`${m.slot}|${w}|${sessionType(m.slot, date)}`)) continue;
        sessions.set(id, {
          id, batchId: batch.id, slot: m.slot, phase: SLOTS[m.slot].phase, week: w, date,
          day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(date)],
          type: sessionType(m.slot, date), zoomAccount: m.zoomAccount, meetingId: m.meetingId, hostEmail: m.hostEmail || null,
          scheduledTime: m.startTime || null, scheduledDuration: m.durationMin || null, hasData: false
        });
      }
    }
  }

  // ---------- Participant rows → per person per session intervals ----------
  const people = new Map(); // personKey -> person
  const attendance = new Map(); // sessionId -> Map(personKey -> {intervals})
  // Resolve every row once. A second device that joined with no email ("Narayan Bhat", no email) is the
  // same person as the identified "Narayan Bhat" in the same session — merge it instead of counting twice.
  const resolved = [];
  const knownNameInSession = new Map(); // sessionId -> Map(fullName -> identity)
  for (const row of rows) {
    if (isStaffEmail(row.email)) continue; // Harsh's own host logins are not learners
    const s = instanceSession.get(row.instanceUuid);
    if (!s || !row.joinTime || !row.leaveTime) continue;
    const reg = row.registrantId ? registrantById.get(row.registrantId) : null;
    const email = row.email || reg?.email || "";
    const phone = reg?.phone || "";
    const id = resolveIdentity({ name: row.name, email, phone }, index, links);
    resolved.push({ row, s, email, phone, id });
    if (id.excluded || !email) continue;
    if (!knownNameInSession.has(s.id)) knownNameInSession.set(s.id, new Map());
    const names = knownNameInSession.get(s.id);
    for (const n of [row.name, id.learnerId ? index.byId.get(id.learnerId)?.name : null]) {
      const k = fullNameKey(n);
      if (k && !names.has(k)) names.set(k, id);
    }
  }
  for (const r of resolved) {
    if (r.email || r.id.excluded || r.id.learnerId != null) continue;
    const twin = knownNameInSession.get(r.s.id)?.get(fullNameKey(r.row.name));
    if (twin) r.id = twin;
  }
  for (const { row, s, email, phone, id } of resolved) {
    s.rowCount++;
    if (!s.maxLeaveIso || new Date(row.leaveTime) > new Date(s.maxLeaveIso)) s.maxLeaveIso = row.leaveTime;
    if (id.excluded) continue;

    let p = people.get(id.personKey);
    if (!p) {
      const learner = id.learnerId ? index.byId.get(id.learnerId) : null;
      p = {
        personKey: id.personKey, identityKey: id.identityKey, learnerId: id.learnerId, via: id.via,
        names: [], emails: [], phone, region: regionFor({ phone: learner?.phone || phone, country: learner?.country })
      };
      people.set(id.personKey, p);
    }
    p.names.push(row.name);
    if (email) p.emails.push(normEmail(email) || email);
    if (!p.region && phone) p.region = regionFor({ phone });

    if (!attendance.has(s.id)) attendance.set(s.id, new Map());
    const perSession = attendance.get(s.id);
    if (!perSession.has(id.personKey)) perSession.set(id.personKey, { intervals: [], zoomNames: [], zoomEmails: [] });
    const a = perSession.get(id.personKey);
    a.intervals.push([minutesBetween(s.startIso, row.joinTime), minutesBetween(s.startIso, row.leaveTime)]);
    a.zoomNames.push(row.name);
    if (email) a.zoomEmails.push(email);
  }

  // ---------- Per-session metrics ----------
  const personSessions = new Map(); // personKey -> [{sessionId, minutes, ...}]
  const sessionList = [];
  const sessionDetail = new Map();
  // First date each slot has Zoom data; a past session before it ran before tracking (or on a meeting we can't see)
  const firstDataBySlot = new Map();
  for (const s of sessions.values()) {
    if (s.hasData && (s.rowCount || s.endIso) && (!firstDataBySlot.has(s.slot) || s.date < firstDataBySlot.get(s.slot))) firstDataBySlot.set(s.slot, s.date);
  }
  for (const s of sessions.values()) {
    // Zoom listed the instance but its participant report hasn't arrived yet
    if (s.hasData && !s.rowCount && !s.endIso) s.hasData = false;
    if (s.hasData && !s.endIso) s.endIso = s.maxLeaveIso;
    const durationMin = s.hasData
      ? Math.max(1, Math.round(minutesBetween(s.startIso, s.endIso)))
      : (s.scheduledDuration || (SLOTS[s.slot].kind === "learning" ? 90 : 60));
    const startTime = s.hasData ? istTime(s.startIso) : (s.scheduledTime || null);
    const registeredMap = registeredByMeeting.get(String(s.meetingId || "").replace(/\s/g, "")) || null;
    const perSession = attendance.get(s.id) || new Map();
    // "Late" counts from the scheduled class time, not from when the host opened the room
    // (rooms open 10-15 min early, and a host test-start can be half an hour early)
    const classStartOffset = s.hasData && s.scheduledTime
      ? Math.min(Math.max(0, Math.round(minutesBetween(s.startIso, istInstant(s.date, s.scheduledTime)))), Math.max(0, durationMin - 1))
      : 0;

    const participants = [];
    for (const [personKey, a] of perSession) {
      const segs = unionIntervals(a.intervals.map(([x, y]) => [Math.max(0, x), Math.min(durationMin, y)]));
      // Completed minutes only: 19m 40s is 19, so the "20+ minutes" rule is applied exactly
      const total = Math.floor(segs.reduce((t, [x, y]) => t + (y - x), 0) + 1e-9);
      const person = people.get(personKey);
      const learner = person.learnerId ? index.byId.get(person.learnerId) : null;
      const segments = segs.map(([x, y]) => ({ startMin: Math.floor(x), endMin: Math.max(Math.floor(x) + 1, Math.ceil(y)) }));
      const part = {
        personKey,
        zoomName: mostCommon(a.zoomNames) || "Unknown",
        zoomEmail: mostCommon(a.zoomEmails),
        learnerId: learner?.id ?? null,
        learnerName: learner?.name ?? null,
        region: person.region,
        segments,
        totalMinutes: total,
        rejoins: Math.max(0, a.intervals.length - 1),
        firstJoinOffset: segments.length ? segments[0].startMin : 0,
        lastLeaveOffset: segments.length ? segments[segments.length - 1].endMin : 0
      };
      part.minutesAfterClassStart = Math.max(0, part.firstJoinOffset - classStartOffset);
      part.late = part.firstJoinOffset > classStartOffset + rules.lateThresholdMinutes;
      part.leftEarly = part.lastLeaveOffset < durationMin - rules.leftEarlyMinutes;
      participants.push(part);
      if (!personSessions.has(personKey)) personSessions.set(personKey, []);
      personSessions.get(personKey).push({ sessionId: s.id, minutes: total, segments, week: s.week, type: s.type, phase: s.phase, date: s.date, startTime, durationMin });
    }

    const attended = participants.filter(p => p.totalMinutes >= rules.attendedMinMinutes);
    // Paid = matched to a TagMango learner who isn't refunded; everyone else is reported separately
    const isPaid = p => p.learnerId != null && index.byId.get(p.learnerId)?.status !== "refunded";
    const paidAttended = attended.filter(isPaid).length;
    const unmatchedAttended = attended.filter(p => p.learnerId == null).length;
    const step = durationMin > 180 ? 5 : 1;
    const curve = [];
    if (participants.length) {
      for (let m = 0; m <= durationMin; m += step) {
        let c = 0;
        for (const p of participants) if (p.segments.some(g => g.startMin <= m && m < g.endMin)) c++;
        curve.push({ minute: m, count: c });
      }
    }
    const status = s.hasData ? "Synced"
      : (s.date > today ? "Upcoming"
      : (input.syncErrors?.get(s.zoomAccount) ? "Sync failed"
      : (firstDataBySlot.has(s.slot) && s.date < firstDataBySlot.get(s.slot) ? "Not in Zoom" : "Awaiting data")));

    const summary = {
      id: s.id, batchId: s.batchId, slot: s.slot, week: s.week, weekLabel: s.phase === "Phase 2" ? s.week + WEEKS : s.week,
      date: s.date, day: s.day, phase: s.phase, type: s.type, startTime, durationMin, scheduledTime: s.scheduledTime || null,
      zoomAccount: s.zoomAccount, meetingId: s.meetingId, hostEmail: s.hostEmail || null, status,
      syncError: status === "Sync failed" ? input.syncErrors.get(s.zoomAccount) : null,
      registered: registeredMap ? registeredMap.size : null, // null = this session's Zoom link has no registrations
      joined: s.hasData ? participants.length : null,
      attended: s.hasData ? attended.length : null,
      paidAttended: s.hasData ? paidAttended : null,
      unmatchedAttended: s.hasData ? unmatchedAttended : null,
      cohort: null, // paid learners in this phase; filled in once rosters are known
      avgMinutes: s.hasData && participants.length ? Math.round(participants.reduce((t, p) => t + p.totalMinutes, 0) / participants.length) : null,
      peakConcurrent: s.hasData ? curve.reduce((mx, pt) => Math.max(mx, pt.count), 0) : null,
      classStartOffset,
      pctLate: s.hasData ? (pct(participants.filter(p => p.late).length, participants.length) ?? 0) : null,
      pctLeftEarly: s.hasData ? (pct(participants.filter(p => p.leftEarly).length, participants.length) ?? 0) : null
    };
    sessionList.push(summary);
    sessionDetail.set(s.id, { ...summary, attendanceOverTime: curve, participants });
  }
  sessionList.sort((a, b) => (a.date === b.date ? a.slot.localeCompare(b.slot) : a.date.localeCompare(b.date)));

  // ---------- Phase rosters and learner rows ----------
  const heldByPhase = { "Phase 1": [], "Phase 2": [] };
  for (const s of sessionList) if (s.status === "Synced" && SESSION_TYPES.includes(s.type)) heldByPhase[s.phase].push(s);

  // Each learner belongs to ONE phase: where they spent the most Sunday Learning minutes, then the most
  // minutes overall, then where they registered. Visits to the other phase's sessions don't make them a member there.
  const phaseMinutes = new Map(); // personKey -> { sun: {P1,P2}, all: {P1,P2}, last: {date, phase} }
  for (const [key, list] of personSessions) {
    if (!key.startsWith("learner:")) continue;
    const pm = { sun: { "Phase 1": 0, "Phase 2": 0 }, all: { "Phase 1": 0, "Phase 2": 0 }, last: null };
    for (const x of list) {
      pm.all[x.phase] += x.minutes;
      if (x.type === "Sunday Learning") pm.sun[x.phase] += x.minutes;
      if (x.minutes > 0 && (!pm.last || x.date > pm.last.date)) pm.last = x;
    }
    phaseMinutes.set(key, pm);
  }
  const registeredPhases = new Map(); // personKey -> Set(phase)
  for (const [slot, regMap] of registeredBySlot) for (const key of regMap.keys()) {
    if (!key.startsWith("learner:")) continue;
    if (!registeredPhases.has(key)) registeredPhases.set(key, new Set());
    registeredPhases.get(key).add(SLOTS[slot].phase);
  }
  const memberPhase = new Map();
  for (const key of new Set([...phaseMinutes.keys(), ...registeredPhases.keys()])) {
    const pm = phaseMinutes.get(key);
    const reg = registeredPhases.get(key) || new Set();
    const pick = (a, b) => (a > b ? "Phase 1" : b > a ? "Phase 2" : null);
    memberPhase.set(key,
      (pm && pick(pm.sun["Phase 1"], pm.sun["Phase 2"])) ||
      (pm && pick(pm.all["Phase 1"], pm.all["Phase 2"])) ||
      (reg.size === 1 ? [...reg][0] : null) ||
      (pm && pm.last ? pm.last.phase : "Phase 1"));
  }
  const rosters = { "Phase 1": new Set(), "Phase 2": new Set() };
  for (const [key, phase] of memberPhase) rosters[phase].add(key);

  const isDnc = l => (normEmail(l.email) && dnc.has(`email:${normEmail(l.email)}`)) || (phoneKey(l.phone) && dnc.has(`phone:${phoneKey(l.phone)}`));
  const learnerRows = [];
  for (const phase of PHASES) {
    const held = heldByPhase[phase];
    const weekHeld = w => held.some(s => s.week === w && s.type === "Sunday Learning");
    for (const personKey of rosters[phase]) {
      const learner = index.byId.get(people.get(personKey)?.learnerId ?? Number(personKey.split(":")[1]));
      if (!learner) continue;
      const mine = (personSessions.get(personKey) || []).filter(x => x.phase === phase);
      const minutesIn = (w, type) => mine.filter(x => x.week === w && x.type === type).reduce((t, x) => t + x.minutes, 0);

      const weeks = [];
      for (let w = 1; w <= WEEKS; w++) {
        const anyHeld = held.some(s => s.week === w);
        if (!anyHeld) { weeks.push({ week: w, label: phase === "Phase 2" ? w + WEEKS : w, sun: null, tue: null, thu: null, status: "upcoming" }); continue; }
        const sun = minutesIn(w, "Sunday Learning"), tue = minutesIn(w, "Tuesday Practice"), thu = minutesIn(w, "Thursday Q&A");
        const status = !weekHeld(w) ? "nosunday" : sun >= rules.attendedMinMinutes ? "attended" : sun > 0 ? "partial" : "missed";
        weeks.push({ week: w, label: phase === "Phase 2" ? w + WEEKS : w, sun, tue, thu, status });
      }

      const attendedWeek = wk => wk.status !== "upcoming" && (
        (rules.attendedSessionTypes.includes("Sunday Learning") && wk.sun >= rules.attendedMinMinutes) ||
        (rules.attendedSessionTypes.includes("Tuesday Practice") && wk.tue >= rules.attendedMinMinutes) ||
        (rules.attendedSessionTypes.includes("Thursday Q&A") && wk.thu >= rules.attendedMinMinutes));
      const heldWeeks = weeks.filter(wk => wk.status !== "upcoming");
      const weeksAttended = heldWeeks.filter(attendedWeek).length;
      let currentStreak = 0;
      for (let i = heldWeeks.length - 1; i >= 0 && attendedWeek(heldWeeks[i]); i--) currentStreak++;

      // Session-level sequences for regular / missed-twice rules
      const seq = types => held.filter(s => types.includes(s.type)).map(s => mine.filter(x => x.sessionId === s.id).reduce((t, x) => t + x.minutes, 0));
      const regSeq = seq(rules.regularSessionTypes);
      let run = 0, bestRegularRun = 0;
      for (const m of regSeq) { run = m >= rules.regularMinMinutes ? run + 1 : 0; bestRegularRun = Math.max(bestRegularRun, run); }
      const missSeq = seq(rules.missedTwiceSessionTypes);
      let missedStreak = 0;
      for (let i = missSeq.length - 1; i >= 0 && missSeq[i] < rules.attendedMinMinutes; i--) missedStreak++;

      const attendedSessions = mine.filter(x => x.minutes >= rules.attendedMinMinutes).sort((a, b) => a.date.localeCompare(b.date));
      const firstAttendedWeek = attendedSessions.length ? attendedSessions[0].week : null;
      // Late joiner = first showed up at all (any minutes) in week 2+, so a short week-1 visit still counts as starting on time
      const joined = mine.filter(x => x.minutes > 0).sort((a, b) => a.date.localeCompare(b.date));
      const firstJoinedWeek = joined.length ? joined[0].week : null;
      const lastAttended = attendedSessions.length ? attendedSessions[attendedSessions.length - 1] : null;
      const lastSunday = attendedSessions.filter(x => x.type === "Sunday Learning").pop();
      // Came to a Tue/Thu practice (20+ min) after their last attended Sunday
      const practiceSinceLastSunday = attendedSessions.some(x => x.type !== "Sunday Learning" && (!lastSunday || x.date > lastSunday.date));

      const regHeld = regSeq.length;
      const regularityScore = regHeld
        ? Math.min(100, Math.round(70 * regSeq.filter(m => m >= rules.attendedMinMinutes).length / regHeld + 30 * regSeq.filter(m => m >= rules.regularMinMinutes).length / regHeld))
        : 0;

      let status;
      if (learner.status === "refunded") status = "refunded";
      // Only judge "late" when week 1 is actually in Zoom; without it we cannot know when someone started
      else if (phase === "Phase 1" && weekHeld(1) && firstJoinedWeek != null && firstJoinedWeek >= 2) status = nextP1.has(personKey) ? "moved" : "late_joiner";
      else if (firstAttendedWeek == null) status = held.length ? "inactive" : "active";
      else if (missedStreak >= rules.missedTwiceCount + 2) status = "inactive";
      else if (missedStreak >= rules.missedTwiceCount) status = "at_risk";
      else status = "active";

      learnerRows.push({
        id: learner.id, rowKey: `${learner.id}:${phase}`, name: learner.name, email: learner.email || "", phone: learner.phone || "",
        country: learner.country || (regionFor(learner) === "India" ? "India" : ""), region: regionFor(learner) || "Unknown",
        batchId: batch.id, phase, status, doNotContact: isDnc(learner),
        paymentDate: learner.paymentDate || "", paymentPlatform: learner.platform || "TagMango",
        weeksAttended, heldWeeks: heldWeeks.length, currentStreak, totalMinutes: mine.reduce((t, x) => t + x.minutes, 0),
        regularityScore, isRegular: bestRegularRun >= rules.regularStreakWeeks, bestRegularRun,
        missedStreak,
        // Call list = just dropped off: missed the last N (or N+1) Sunday sessions in a row after attending before.
        // Missing more than that = "dropped off" (separate list); late joiners restart next batch instead.
        isMissedTwice: firstAttendedWeek != null && missedStreak >= rules.missedTwiceCount && missedStreak < rules.missedTwiceCount + 2,
        droppedOff: firstAttendedWeek != null && missedStreak >= rules.missedTwiceCount + 2,
        practiceSinceLastSunday,
        firstAttendedWeek, firstJoinedWeek, lastAttendedDate: lastAttended?.date || null,
        lastAttended: lastAttended ? `Week ${phase === "Phase 2" ? lastAttended.week + WEEKS : lastAttended.week} · ${fmtShortDate(lastAttended.date)}` : "Never",
        matchMethod: people.get(personKey)?.via || "none",
        weeks
      });
    }
  }

  // ---------- Phase summaries (per region) ----------
  const phaseSummary = {};
  for (const region of REGIONS) {
    phaseSummary[region] = {};
    for (const phase of PHASES) {
      const inRegion = p => region === "All" || p.region === region;
      const held = heldByPhase[phase];
      const rows_ = learnerRows.filter(r => r.phase === phase && (region === "All" || r.region === region));
      const learningSlot = phase === "Phase 1" ? "learning_p1" : "learning_p2";
      const practiceSlot = phase === "Phase 1" ? "practice_p1" : "practice_p2";
      const regCount = slot => [...(registeredBySlot.get(slot) || new Map()).values()].filter(r => region === "All" || r === region).length;
      const registered = regCount(learningSlot); // Zoom registrations: informational (compulsory only from 15 Nov)
      const cohort = rows_.filter(r => r.status !== "refunded").length;
      const denominator = cohort;
      const paidP = p => p.learnerId != null && index.byId.get(p.learnerId)?.status !== "refunded" && memberPhase.get(p.personKey) === phase;

      const weekly = [], weeklyUnmatched = [], weeklyRetained = [], newVsRet = [], funnel = {}, rates = { sunday: [], tuesday: [], thursday: [] };
      let w1People = null; // paid learners who attended week 1 — the cohort retention is measured against
      const seen = new Set();
      let minutesSum = 0, minutesN = 0, stayed = 0;
      for (let w = 1; w <= WEEKS; w++) {
        const sun = held.find(s => s.week === w && s.type === "Sunday Learning");
        const typeRate = (type, slot) => {
          const s = held.find(x => x.week === w && x.type === type);
          if (!s) return null;
          const att = sessionDetail.get(s.id).participants.filter(p => inRegion(p) && paidP(p) && p.totalMinutes >= rules.attendedMinMinutes).length;
          return pct(att, cohort) ?? 0;
        };
        rates.sunday.push(typeRate("Sunday Learning", learningSlot));
        rates.tuesday.push(typeRate("Tuesday Practice", practiceSlot));
        rates.thursday.push(typeRate("Thursday Q&A", practiceSlot));
        if (!sun) { weekly.push(null); weeklyUnmatched.push(null); weeklyRetained.push(null); continue; }
        const everyone = sessionDetail.get(sun.id).participants.filter(inRegion);
        weeklyUnmatched.push(everyone.filter(p => p.learnerId == null && p.totalMinutes >= rules.attendedMinMinutes).length);
        const parts = everyone.filter(paidP);
        const att = parts.filter(p => p.totalMinutes >= rules.attendedMinMinutes);
        weekly.push(att.length);
        if (w === 1) w1People = new Set(att.map(p => p.personKey));
        weeklyRetained.push(w1People ? att.filter(p => w1People.has(p.personKey)).length : null);
        let newCount = 0;
        for (const p of att) { if (!seen.has(p.personKey)) newCount++; }
        att.forEach(p => seen.add(p.personKey));
        newVsRet.push({ week: w, label: phase === "Phase 2" ? w + WEEKS : w, newCount, returningCount: att.length - newCount });
        funnel[w] = { cohort, registered, joined: parts.length, attended20: att.length, stayed60: parts.filter(p => p.totalMinutes >= rules.regularMinMinutes).length, unmatchedAttended: weeklyUnmatched[w - 1] };
        for (const p of att) { minutesSum += p.totalMinutes; minutesN++; if (p.totalMinutes >= rules.regularMinMinutes) stayed++; }
      }
      const heldIdx = weekly.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
      const currentWeek = heldIdx.length ? heldIdx[heldIdx.length - 1] + 1 : 0;
      phaseSummary[region][phase === "Phase 1" ? "p1" : "p2"] = {
        label: phase === "Phase 1" ? "Phase 1 · Straight Flute (new cohort, weeks 1–7)" : "Phase 2 · Side Flute (previous cohort, weeks 8–14)",
        weekOffset: phase === "Phase 2" ? WEEKS : 0,
        configured: phase === "Phase 1" ? (slotsConfigured.has("learning_p1") || slotsConfigured.has("practice_p1")) : (slotsConfigured.has("learning_p2") || slotsConfigured.has("practice_p2")),
        paid: cohort,
        refunded: rows_.filter(r => r.status === "refunded").length,
        registered,
        denominator,
        weeklySundayUnmatched: weeklyUnmatched,
        // Of the week-1 attendees, how many attended each later Sunday (null until week 1 is synced)
        weeklyRetainedFromW1: weeklyRetained,
        w1Attended: weekly[0] ?? 0,
        w1Synced: weekly[0] != null,
        firstSyncedWeek: heldIdx.length ? heldIdx[0] + 1 : null,
        currentWeek,
        currentWeekAttended: currentWeek ? weekly[currentWeek - 1] : 0,
        avgMinutes: minutesN ? Math.round(minutesSum / minutesN) : 0,
        stayed60Pct: minutesN ? Math.round((stayed / minutesN) * 100) : 0,
        lateJoiners: rows_.filter(r => r.status === "late_joiner" || r.status === "moved").length,
        weeklySundayAttended: weekly,
        weeklyNewVsReturning: newVsRet,
        funnelByWeek: funnel,
        sessionTypeRates: rates
      };
    }
  }

  // Each session's % uses the paid learners of its phase (All regions)
  const cohortByPhase = { "Phase 1": phaseSummary.All.p1.paid, "Phase 2": phaseSummary.All.p2.paid };
  for (const s of sessionList) {
    s.cohort = cohortByPhase[s.phase];
    const d = sessionDetail.get(s.id);
    if (!d) continue;
    d.cohort = s.cohort;
    if (!s.hasData && s.status !== "Synced") continue;
    const att = d.participants.filter(p => p.totalMinutes >= rules.attendedMinMinutes && p.learnerId != null && index.byId.get(p.learnerId)?.status !== "refunded");
    s.paidAttended = d.paidAttended = att.filter(p => memberPhase.get(p.personKey) === s.phase).length;
    s.otherPhaseAttended = d.otherPhaseAttended = att.length - s.paidAttended;
  }

  // ---------- People without a learner match ----------
  const unmatched = [];
  for (const p of people.values()) {
    if (p.learnerId != null) continue;
    const mine = personSessions.get(p.personKey) || [];
    if (!mine.length) continue;
    const byPhase = { "Phase 1": 0, "Phase 2": 0 };
    mine.forEach(x => { byPhase[x.phase] += x.minutes; });
    const lastSeen = mine.reduce((d, x) => (x.date > d ? x.date : d), "");
    unmatched.push({
      id: p.identityKey,
      zoomName: mostCommon(p.names) || "Unknown",
      zoomEmail: mostCommon(p.emails),
      phone: p.phone || "",
      region: p.region || "Unknown",
      batchId: batch.id,
      phase: byPhase["Phase 2"] > byPhase["Phase 1"] ? "Phase 2" : "Phase 1",
      sessionsSeen: mine.length,
      sessionsAttended: mine.filter(x => x.minutes >= rules.attendedMinMinutes).length,
      totalMinutes: mine.reduce((t, x) => t + x.minutes, 0),
      lastSeen
    });
  }
  unmatched.sort((a, b) => b.totalMinutes - a.totalMinutes);

  // ---------- Lists ----------
  const contactable = learnerRows.filter(r => !r.doNotContact && r.status !== "refunded");
  const lists = {
    dncExcludedCount: learnerRows.filter(r => r.doNotContact).length,
    missedTwice: contactable.filter(r => r.isMissedTwice && r.status !== "moved" && r.status !== "late_joiner"),
    droppedOff: contactable.filter(r => r.droppedOff && r.status !== "moved" && r.status !== "late_joiner"),
    diamondShowcase: contactable.filter(r => r.isRegular).sort((a, b) => b.regularityScore - a.regularityScore || b.totalMinutes - a.totalMinutes),
    lateJoiners: contactable.filter(r => r.status === "late_joiner" || r.status === "moved"),
    notPaid: unmatched.filter(u => u.sessionsAttended > 0).map(u => ({ ...u, note: "No TagMango match" })),
    doNotContact: learnerRows.filter(r => r.doNotContact)
  };

  const status = batchStatus(batch, today);
  return {
    batch: {
      id: batch.id, name: batch.name || `Batch starting ${fmtShortDate(batch.startDate)}`, shortName: fmtShortDate(batch.startDate),
      startDate: batch.startDate, status, totalWeeks: WEEKS, breakWeeks: cal.breaks, endDate: cal.lastDay,
      currentWeek: Math.max(phaseSummary.All.p1.currentWeek, phaseSummary.All.p2.currentWeek),
      calendarWeek: status === "Active" ? (teachingWeekOf(cal, today) || 0) : (status === "Completed" ? WEEKS : 0),
      inBreakWeek: status === "Active" && cal.breaks.some(b => today >= b && today <= addDays(b, 6)),
      hasData: sessionList.some(s => s.status === "Synced"),
      meetingsConfigured: meetings.length,
      phaseSummary
    },
    rules,
    sessions: sessionList,
    sessionDetail,
    learners: learnerRows,
    personSessions,
    people,
    unmatched,
    lists
  };
}

/** Phase-1 people (personKeys) who attended anything in a batch model — used to detect "moved". */
export function phase1Attendees(model) {
  const out = new Set();
  for (const s of model.sessions) {
    if (s.phase !== "Phase 1" || s.status !== "Synced") continue;
    for (const p of model.sessionDetail.get(s.id).participants) if (p.totalMinutes >= model.rules.attendedMinMinutes) out.add(p.personKey);
  }
  return out;
}

/** Learners who attended any session within the active window, across the given batch models. */
export function activeLearners(models, { today, rules }) {
  const r = { ...DEFAULT_RULES, ...(rules || {}) };
  const since = addDays(today, -r.activeWindowDays);
  const best = new Map();
  for (const m of models) {
    for (const row of m.learners) {
      if (!row.lastAttendedDate || row.lastAttendedDate < since) continue;
      const prev = best.get(row.id);
      if (!prev || row.lastAttendedDate > prev.lastAttendedDate) best.set(row.id, row);
    }
  }
  return [...best.values()].filter(row => !row.doNotContact && row.status !== "refunded").sort((a, b) => b.regularityScore - a.regularityScore);
}

export { normName };


/**
 * The 14-week journey of the group that STARTED in `cur` (its Phase 1 members):
 * weeks 1–7 come from `cur` Phase 1, weeks 8–14 from `next` Phase 2 (the same people, one batch later).
 * Someone who restarts in the next batch's Phase 1 (a late joiner) is "Restarted", not a Phase 2 continuer.
 */
export function buildJourney(cur, next, rules = DEFAULT_RULES) {
  const r = { ...DEFAULT_RULES, ...rules };
  const attended = wk => !!wk && wk.status !== "upcoming" && (
    (r.attendedSessionTypes.includes("Sunday Learning") && wk.sun >= r.attendedMinMinutes) ||
    (r.attendedSessionTypes.includes("Tuesday Practice") && wk.tue >= r.attendedMinMinutes) ||
    (r.attendedSessionTypes.includes("Thursday Q&A") && wk.thu >= r.attendedMinMinutes));
  const p2 = new Map((next ? next.learners.filter(x => x.phase === "Phase 2") : []).map(x => [x.id, x]));
  const restarted = new Set((next ? next.learners.filter(x => x.phase === "Phase 1") : []).map(x => x.id));
  const nextStatus = next ? next.batch.status : "Not set up";
  const blankPhase2 = Array.from({ length: WEEKS }, (_, i) => ({ week: i + 1, sun: null, tue: null, thu: null, status: "upcoming" }));
  const phase2Done = nextStatus === "Completed";
  const phase1Done = cur.batch.status === "Completed";

  const learners = cur.learners.filter(x => x.phase === "Phase 1" && x.status !== "refunded").map(x => {
    const q = p2.get(x.id);
    const weeks = [
      ...x.weeks.map(w => ({ ...w, label: w.week })),
      ...(q ? q.weeks : blankPhase2).map(w => ({ ...w, label: w.week + WEEKS }))
    ];
    const att = weeks.map(attended);
    const any = (a, b) => att.slice(a, b).some(Boolean);
    const startedW1 = att[0];
    let stage;
    if (att[2 * WEEKS - 1]) stage = "Completed";
    else if (restarted.has(x.id) && !any(WEEKS, 2 * WEEKS)) stage = "Restarted next batch";
    else if (any(WEEKS, 2 * WEEKS)) stage = phase2Done ? "Stopped in Phase 2" : "In Phase 2";
    else if (!phase1Done) stage = "In Phase 1";
    else if (next && (nextStatus === "Active" || phase2Done)) stage = "Did not continue";
    else stage = "Finished Phase 1";
    return {
      id: x.id, name: x.name, email: x.email, phone: x.phone, region: x.region, doNotContact: x.doNotContact,
      startedW1, lateStart: !startedW1 && att.some(Boolean),
      weeks: weeks.map((w, i) => ({ label: w.label, status: w.status === "upcoming" ? "upcoming" : att[i] ? "attended" : (w.sun || w.tue || w.thu) ? "partial" : "missed" })),
      weeksAttended: att.filter(Boolean).length,
      weeksHeld: weeks.filter(w => w.status !== "upcoming").length,
      reachedW7: att[WEEKS - 1], joinedPhase2: any(WEEKS, 2 * WEEKS), reachedW14: att[2 * WEEKS - 1],
      stage
    };
  });

  const starters = learners.filter(l => l.startedW1);
  // Sunday of each of the 14 weeks: 1–7 from this batch (breaks skipped), 8–14 from the next batch
  // (or the 7 Sundays after this batch if the next one isn't set up yet)
  const curCal = batchCalendar({ startDate: cur.batch.startDate, breakWeeks: cur.batch.breakWeeks || [] });
  const nextSundays = next
    ? batchCalendar({ startDate: next.batch.startDate, breakWeeks: next.batch.breakWeeks || [] }).sundays
    : Array.from({ length: WEEKS }, (_, i) => addDays(curCal.lastDay, 1 + i * 7));
  const weekDates = [...curCal.sundays, ...nextSundays];
  const weekly = Array.from({ length: 2 * WEEKS }, (_, i) => {
    const held = learners.some(l => l.weeks[i].status !== "upcoming");
    return held ? learners.filter(l => l.weeks[i].status === "attended").length : null;
  });
  return {
    cohort: {
      batchId: cur.batch.id, name: cur.batch.name, startDate: cur.batch.startDate, phase1End: cur.batch.endDate, phase1Status: cur.batch.status,
      nextBatchId: next ? next.batch.id : null, nextName: next ? next.batch.name : null,
      phase2Start: next ? next.batch.startDate : null, phase2End: next ? next.batch.endDate : null, phase2Status: nextStatus
    },
    // Funnel follows the true cohort: people who attended week 1
    funnel: {
      learners: learners.length,
      startedW1: starters.length,
      reachedW7: starters.filter(l => l.reachedW7).length,
      joinedPhase2: starters.filter(l => l.joinedPhase2).length,
      reachedW14: starters.filter(l => l.reachedW14).length,
      completedAll: learners.filter(l => l.reachedW14).length, // incl. late starters who still reached week 14
      completedLateStart: learners.filter(l => l.reachedW14 && !l.startedW1).length
    },
    weeklyAttended: weekly,
    weekDates,
    weekDatesPlanned: !next, // weeks 8–14 dates are an estimate until the next batch is set up
    stages: learners.reduce((o, l) => ((o[l.stage] = (o[l.stage] || 0) + 1), o), {}),
    learners: learners.sort((a, b) => b.weeksAttended - a.weeksAttended || String(a.name).localeCompare(String(b.name)))
  };
}
