// Pure analytics: Zoom join/leave rows + learners + rules  →  everything the dashboard shows.
// No I/O here, so every number on screen can be unit-tested from plain objects.
import { istDate, istTime, weekday, addDays, daysBetween, fmtShortDate } from "./time.js";
import { buildLearnerIndex, resolveIdentity, normEmail, phoneKey, regionFor, normName } from "./match.js";

export const SLOTS = {
  learning_p1: { phase: "Phase 1", kind: "learning", label: "Learning Session (Phase 1 · Straight)" },
  learning_p2: { phase: "Phase 2", kind: "learning", label: "Learning Session (Phase 2 · Side)" },
  practice_p1: { phase: "Phase 1", kind: "practice", label: "Practice & Q&A (Phase 1 · Tue + Thu)" },
  practice_p2: { phase: "Phase 2", kind: "practice", label: "Practice & Q&A (Phase 2 · Tue + Thu)" }
};
export const PHASES = ["Phase 1", "Phase 2"];
export const SESSION_TYPES = ["Sunday Learning", "Tuesday Practice", "Thursday Q&A"];
export const WEEKS = 7;
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

export function batchStatus(batch, today) {
  if (today < batch.startDate) return "Upcoming";
  if (today > addDays(batch.startDate, WEEKS * 7 - 1)) return "Completed";
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
    for (const slot of meetingSlotsByZoomId.get(String(r.meetingId).replace(/\s/g, "")) || []) {
      registeredBySlot.get(slot)?.set(id.personKey, region);
    }
  }

  // ---------- Sessions: one per (slot, IST date); several Zoom instances on a day merge ----------
  const sessions = new Map();
  const sessionIdFor = (slot, date) => `${batch.id}-${slot}-${date}`;
  const instanceSession = new Map();
  for (const inst of instances) {
    const m = meetingById.get(inst.batchMeetingId);
    if (!m) continue;
    const date = istDate(inst.startTime);
    const week = weekOf(batch.startDate, date);
    if (week < 1 || week > WEEKS) continue; // belongs to another cycle
    const id = sessionIdFor(m.slot, date);
    let s = sessions.get(id);
    if (!s) {
      s = {
        id, batchId: batch.id, slot: m.slot, phase: SLOTS[m.slot].phase, week, date,
        day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(date)],
        type: sessionType(m.slot, date), zoomAccount: m.zoomAccount, meetingId: m.meetingId,
        startIso: inst.startTime, endIso: inst.endTime || null, hasData: true, instanceCount: 0, rowCount: 0,
        scheduledTime: m.startTime || null, scheduledDuration: m.durationMin || null
      };
      sessions.set(id, s);
    }
    s.instanceCount++;
    if (new Date(inst.startTime) < new Date(s.startIso)) s.startIso = inst.startTime;
    if (inst.endTime && (!s.endIso || new Date(inst.endTime) > new Date(s.endIso))) s.endIso = inst.endTime;
    instanceSession.set(inst.uuid, s);
  }

  // Expected-but-missing sessions (future ones and ones Zoom hasn't returned yet)
  for (const m of meetings) {
    for (let w = 1; w <= WEEKS; w++) {
      const offsets = SLOTS[m.slot].kind === "learning" ? [0] : [2, 4];
      for (const off of offsets) {
        const date = addDays(batch.startDate, (w - 1) * 7 + off);
        const id = sessionIdFor(m.slot, date);
        if (sessions.has(id)) continue;
        sessions.set(id, {
          id, batchId: batch.id, slot: m.slot, phase: SLOTS[m.slot].phase, week: w, date,
          day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][weekday(date)],
          type: sessionType(m.slot, date), zoomAccount: m.zoomAccount, meetingId: m.meetingId,
          scheduledTime: m.startTime || null, scheduledDuration: m.durationMin || null, hasData: false
        });
      }
    }
  }

  // ---------- Participant rows → per person per session intervals ----------
  const people = new Map(); // personKey -> person
  const attendance = new Map(); // sessionId -> Map(personKey -> {intervals})
  for (const row of rows) {
    const s = instanceSession.get(row.instanceUuid);
    if (!s || !row.joinTime || !row.leaveTime) continue;
    s.rowCount++;
    if (!s.maxLeaveIso || new Date(row.leaveTime) > new Date(s.maxLeaveIso)) s.maxLeaveIso = row.leaveTime;
    const reg = row.registrantId ? registrantById.get(row.registrantId) : null;
    const email = row.email || reg?.email || "";
    const phone = reg?.phone || "";
    const id = resolveIdentity({ name: row.name, email, phone }, index, links);
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
  for (const s of sessions.values()) {
    // Zoom listed the instance but its participant report hasn't arrived yet
    if (s.hasData && !s.rowCount && !s.endIso) s.hasData = false;
    if (s.hasData && !s.endIso) s.endIso = s.maxLeaveIso;
    const durationMin = s.hasData
      ? Math.max(1, Math.round(minutesBetween(s.startIso, s.endIso)))
      : (s.scheduledDuration || (SLOTS[s.slot].kind === "learning" ? 90 : 60));
    const startTime = s.hasData ? istTime(s.startIso) : (s.scheduledTime || null);
    const registeredMap = registeredBySlot.get(s.slot) || new Map();
    const perSession = attendance.get(s.id) || new Map();

    const participants = [];
    for (const [personKey, a] of perSession) {
      const segs = unionIntervals(a.intervals.map(([x, y]) => [Math.max(0, x), Math.min(durationMin, y)]));
      const total = Math.round(segs.reduce((t, [x, y]) => t + (y - x), 0));
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
      participants.push(part);
      if (!personSessions.has(personKey)) personSessions.set(personKey, []);
      personSessions.get(personKey).push({ sessionId: s.id, minutes: total, segments, week: s.week, type: s.type, phase: s.phase, date: s.date, startTime, durationMin });
    }

    const attended = participants.filter(p => p.totalMinutes >= rules.attendedMinMinutes);
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
      : (input.syncErrors?.get(s.zoomAccount) ? "Sync failed" : "Awaiting data"));

    const summary = {
      id: s.id, batchId: s.batchId, slot: s.slot, week: s.week, weekLabel: s.phase === "Phase 2" ? s.week + WEEKS : s.week,
      date: s.date, day: s.day, phase: s.phase, type: s.type, startTime, durationMin,
      zoomAccount: s.zoomAccount, meetingId: s.meetingId, status,
      syncError: status === "Sync failed" ? input.syncErrors.get(s.zoomAccount) : null,
      registered: registeredMap.size,
      joined: s.hasData ? participants.length : null,
      attended: s.hasData ? attended.length : null,
      avgMinutes: s.hasData && participants.length ? Math.round(participants.reduce((t, p) => t + p.totalMinutes, 0) / participants.length) : null,
      peakConcurrent: s.hasData ? curve.reduce((mx, pt) => Math.max(mx, pt.count), 0) : null,
      pctLate: s.hasData ? (pct(participants.filter(p => p.firstJoinOffset > rules.lateThresholdMinutes).length, participants.length) ?? 0) : null,
      pctLeftEarly: s.hasData ? (pct(participants.filter(p => p.lastLeaveOffset < durationMin - rules.leftEarlyMinutes).length, participants.length) ?? 0) : null
    };
    sessionList.push(summary);
    sessionDetail.set(s.id, { ...summary, attendanceOverTime: curve, participants });
  }
  sessionList.sort((a, b) => (a.date === b.date ? a.slot.localeCompare(b.slot) : a.date.localeCompare(b.date)));

  // ---------- Phase rosters and learner rows ----------
  const heldByPhase = { "Phase 1": [], "Phase 2": [] };
  for (const s of sessionList) if (s.status === "Synced" && SESSION_TYPES.includes(s.type)) heldByPhase[s.phase].push(s);

  const rosters = { "Phase 1": new Set(), "Phase 2": new Set() };
  for (const [slot, regMap] of registeredBySlot) for (const key of regMap.keys()) if (key.startsWith("learner:")) rosters[SLOTS[slot].phase].add(key);
  for (const s of sessionList) {
    const det = sessionDetail.get(s.id);
    for (const p of det.participants) if (p.learnerId != null) rosters[s.phase].add(p.personKey);
  }

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

      const regHeld = regSeq.length;
      const regularityScore = regHeld
        ? Math.min(100, Math.round(70 * regSeq.filter(m => m >= rules.attendedMinMinutes).length / regHeld + 30 * regSeq.filter(m => m >= rules.regularMinMinutes).length / regHeld))
        : 0;

      let status;
      if (learner.status === "refunded") status = "refunded";
      else if (phase === "Phase 1" && firstJoinedWeek != null && firstJoinedWeek >= 2) status = nextP1.has(personKey) ? "moved" : "late_joiner";
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
        missedStreak, isMissedTwice: firstAttendedWeek != null && missedStreak >= rules.missedTwiceCount,
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
      const registered = regCount(learningSlot);
      const denominator = registered || rows_.length;

      const weekly = [], newVsRet = [], funnel = {}, rates = { sunday: [], tuesday: [], thursday: [] };
      const seen = new Set();
      let minutesSum = 0, minutesN = 0, stayed = 0;
      for (let w = 1; w <= WEEKS; w++) {
        const sun = held.find(s => s.week === w && s.type === "Sunday Learning");
        const typeRate = (type, slot) => {
          const s = held.find(x => x.week === w && x.type === type);
          if (!s) return null;
          const att = sessionDetail.get(s.id).participants.filter(p => inRegion(p) && p.totalMinutes >= rules.attendedMinMinutes).length;
          return pct(att, regCount(slot) || rows_.length) ?? 0;
        };
        rates.sunday.push(typeRate("Sunday Learning", learningSlot));
        rates.tuesday.push(typeRate("Tuesday Practice", practiceSlot));
        rates.thursday.push(typeRate("Thursday Q&A", practiceSlot));
        if (!sun) { weekly.push(null); continue; }
        const parts = sessionDetail.get(sun.id).participants.filter(inRegion);
        const att = parts.filter(p => p.totalMinutes >= rules.attendedMinMinutes);
        weekly.push(att.length);
        let newCount = 0;
        for (const p of att) { if (!seen.has(p.personKey)) newCount++; }
        att.forEach(p => seen.add(p.personKey));
        newVsRet.push({ week: w, label: phase === "Phase 2" ? w + WEEKS : w, newCount, returningCount: att.length - newCount });
        funnel[w] = { registered, joined: parts.length, attended20: att.length, stayed60: parts.filter(p => p.totalMinutes >= rules.regularMinMinutes).length };
        for (const p of att) { minutesSum += p.totalMinutes; minutesN++; if (p.totalMinutes >= rules.regularMinMinutes) stayed++; }
      }
      const heldIdx = weekly.map((v, i) => (v == null ? -1 : i)).filter(i => i >= 0);
      const currentWeek = heldIdx.length ? heldIdx[heldIdx.length - 1] + 1 : 0;
      phaseSummary[region][phase === "Phase 1" ? "p1" : "p2"] = {
        label: phase === "Phase 1" ? "Phase 1 · Straight Flute (new cohort, weeks 1–7)" : "Phase 2 · Side Flute (previous cohort, weeks 8–14)",
        weekOffset: phase === "Phase 2" ? WEEKS : 0,
        configured: phase === "Phase 1" ? (slotsConfigured.has("learning_p1") || slotsConfigured.has("practice_p1")) : (slotsConfigured.has("learning_p2") || slotsConfigured.has("practice_p2")),
        paid: rows_.length,
        refunded: rows_.filter(r => r.status === "refunded").length,
        registered,
        denominator,
        w1Attended: weekly[0] ?? 0,
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
    missedTwice: contactable.filter(r => r.isMissedTwice && r.status !== "moved"),
    diamondShowcase: contactable.filter(r => r.isRegular).sort((a, b) => b.regularityScore - a.regularityScore || b.totalMinutes - a.totalMinutes),
    lateJoiners: contactable.filter(r => r.status === "late_joiner" || r.status === "moved"),
    notPaid: unmatched.filter(u => u.sessionsAttended > 0).map(u => ({ ...u, note: "No TagMango match" })),
    doNotContact: learnerRows.filter(r => r.doNotContact)
  };

  const status = batchStatus(batch, today);
  return {
    batch: {
      id: batch.id, name: batch.name || `Batch starting ${fmtShortDate(batch.startDate)}`, shortName: fmtShortDate(batch.startDate),
      startDate: batch.startDate, status, totalWeeks: WEEKS,
      currentWeek: Math.max(phaseSummary.All.p1.currentWeek, phaseSummary.All.p2.currentWeek),
      calendarWeek: status === "Active" ? weekOf(batch.startDate, today) : (status === "Completed" ? WEEKS : 0),
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
