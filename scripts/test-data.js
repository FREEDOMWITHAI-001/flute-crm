// Load or remove a small, clearly-marked TEST dataset (10 learners, one 7-week batch).
//   npm run testdata          → load (replaces any previous test data)
//   npm run testdata:clear    → remove every test row
// Test rows are recognisable everywhere: batch "TEST batch …", emails @test.invalid, Zoom account "test"
// (not a real account, so the Zoom sync never touches these meetings).
import { initDb, q, q1, insertMany, db } from "../server/db.js";
import { ensureFirstAdmin } from "../server/auth.js";
import { addDays } from "../server/time.js";

const START = "2026-11-01"; // a Sunday; weeks 1–4 have happened by late November
const TEST_DOMAIN = "test.invalid";

const learners = [
  // name, email local part, phone, country, status, attendance profile
  ["Asha Rao (TEST)", "asha", "+91 90000 00001", "India", "paid", "regular"],
  ["Bala Iyer (TEST)", "bala", "+91 90000 00002", "India", "paid", "regular_phone_only"],
  ["Chitra Nair (TEST)", "chitra", "+1 415 555 0103", "USA", "paid", "overseas_regular"],
  ["Dev Kumar (TEST)", "dev", "+91 90000 00004", "India", "paid", "late_joiner"],
  ["Esha Paul (TEST)", "esha", "+91 90000 00005", "India", "refunded", "dropped"],
  ["Farah Khan (TEST)", "farah", "+91 90000 00006", "India", "paid", "missed_twice"],
  ["Gita Menon (TEST)", "gita", "+44 7700 900007", "UK", "paid", "partial"],
  ["Hari Das (TEST)", "hari", "+91 90000 00008", "India", "paid", "never"],
  ["Isha Verma (TEST)", "isha", "+91 90000 00009", "India", "paid", "phase2"],
  ["Jay Shah (TEST)", "jay", "+91 90000 00010", "India", "paid", "phase2_dropping"]
];

async function clear() {
  await q(`DELETE FROM batches WHERE name LIKE 'TEST batch%'`); // cascades to meetings, instances, participants
  await q(`DELETE FROM zoom_registrants WHERE meeting_id LIKE 'TEST-%'`);
  await q(`DELETE FROM identity_links WHERE identity_key LIKE '%${TEST_DOMAIN}' OR identity_key LIKE 'name:test %'`);
  await q(`DELETE FROM dnc WHERE key LIKE '%${TEST_DOMAIN}' OR key = 'phone:9000000006'`);
  await q(`DELETE FROM learners WHERE source_key LIKE '%@${TEST_DOMAIN}'`);
  await q(`DELETE FROM sync_runs WHERE source = 'TEST data'`);
}

// IST "HH:MM" on a date → UTC ISO
const istIso = (date, hhmm, plusMin = 0) => new Date(new Date(`${date}T${hhmm}:00+05:30`).getTime() + plusMin * 60_000).toISOString();

async function load() {
  await clear();
  const ids = {};
  for (const [name, local, phone, country, status] of learners) {
    const email = `${local}@${TEST_DOMAIN}`;
    const r = await q1(
      `INSERT INTO learners (source_key, name, email, phone, country, payment_date, platform, product, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'TagMango', 'Flute Hackathon (TEST)', $7) RETURNING id`,
      [`email:${email}`, name, email, phone, country, "2026-10-28", status]);
    ids[local] = r.id;
  }

  const batch = await q1(`INSERT INTO batches (name, start_date) VALUES ('TEST batch (sample data)', $1) RETURNING id`, [START]);
  const meeting = async (slot, mid, time, dur) => (await q1(
    `INSERT INTO batch_meetings (batch_id, slot, zoom_account, meeting_id, topic, start_time, duration_min)
     VALUES ($1, $2, 'test', $3, $4, $5, $6) RETURNING id`,
    [batch.id, slot, mid, `TEST ${slot}`, time, dur])).id;
  const m = {
    learning_p1: await meeting("learning_p1", "TEST-LP1", "19:00", 90),
    practice_p1: await meeting("practice_p1", "TEST-PP1", "19:30", 60),
    learning_p2: await meeting("learning_p2", "TEST-LP2", "21:00", 90),
    practice_p2: await meeting("practice_p2", "TEST-PP2", "20:45", 60)
  };

  // Registrations (the compulsory Zoom registration). Bala registered with a different email, so he matches by phone.
  const regs = [];
  for (const [name, local, phone, , , profile] of learners) {
    const meetingId = profile.startsWith("phase2") ? "TEST-LP2" : "TEST-LP1";
    const email = profile === "regular_phone_only" ? "bala.personal@gmail.test" : `${local}@${TEST_DOMAIN}`;
    regs.push([meetingId, `TESTREG-${local}`, email, name.split(" ")[0], "", profile === "regular_phone_only" ? phone : ""]);
  }
  await insertMany(db(), "zoom_registrants", ["meeting_id", "registrant_id", "email", "first_name", "last_name", "phone"], regs);

  // Minutes each person spends in each Sunday learning session, weeks 1–4 (0 = absent)
  const sundayMinutes = {
    regular: [88, 85, 90, 86],
    regular_phone_only: [75, 80, 70, 72],
    overseas_regular: [65, 62, 70, 61],
    late_joiner: [0, 0, 80, 85],
    dropped: [60, 0, 0, 0],
    missed_twice: [70, 66, 0, 0],
    partial: [12, 35, 15, 40],
    never: [0, 0, 0, 0],
    phase2: [85, 82, 88, 90],
    phase2_dropping: [70, 40, 0, 0]
  };
  const instances = [];
  const rows = [];
  for (let w = 0; w < 4; w++) {
    const sun = addDays(START, w * 7), tue = addDays(sun, 2), thu = addDays(sun, 4);
    const sessions = [
      { key: "learning_p1", uuid: `test-lp1-${sun}`, date: sun, time: "19:00", dur: 90, phase: 1, kind: "sun" },
      { key: "learning_p2", uuid: `test-lp2-${sun}`, date: sun, time: "21:00", dur: 90, phase: 2, kind: "sun" },
      { key: "practice_p1", uuid: `test-pp1-${tue}`, date: tue, time: "19:30", dur: 60, phase: 1, kind: "tue" },
      { key: "practice_p1", uuid: `test-pp1-${thu}`, date: thu, time: "19:30", dur: 60, phase: 1, kind: "thu" },
      { key: "practice_p2", uuid: `test-pp2-${tue}`, date: tue, time: "20:45", dur: 60, phase: 2, kind: "tue" },
      { key: "practice_p2", uuid: `test-pp2-${thu}`, date: thu, time: "20:45", dur: 60, phase: 2, kind: "thu" }
    ];
    for (const s of sessions) {
      instances.push([s.uuid, m[s.key], `TEST-${s.key}`, "test", istIso(s.date, s.time), istIso(s.date, s.time, s.dur), new Date().toISOString()]);
      learners.forEach(([name, local, , , , profile], i) => {
        const inPhase2 = profile.startsWith("phase2");
        if ((s.phase === 2) !== inPhase2) return;
        let minutes = sundayMinutes[profile][w];
        if (s.kind !== "sun") minutes = minutes >= 60 && (i + w + (s.kind === "tue" ? 0 : 1)) % 3 !== 0 ? 45 : 0;
        if (!minutes) return;
        const email = profile === "regular_phone_only" ? "" : `${local}@${TEST_DOMAIN}`;
        const reg = profile === "regular_phone_only" ? `TESTREG-${local}` : null;
        const late = profile === "late_joiner" ? 14 : (i % 4);
        if (profile === "regular" && s.kind === "sun") {
          // Rejoin: drops off for 6 minutes mid-session
          rows.push([s.uuid, name, email, reg, istIso(s.date, s.time, late), istIso(s.date, s.time, 40)]);
          rows.push([s.uuid, name, email, reg, istIso(s.date, s.time, 46), istIso(s.date, s.time, Math.min(s.dur, late + minutes + 6))]);
        } else {
          rows.push([s.uuid, name, email, reg, istIso(s.date, s.time, late), istIso(s.date, s.time, Math.min(s.dur, late + minutes))]);
        }
      });
      // A guest nobody can match automatically → shows up in the Review queue
      if (s.key === "learning_p1" && w < 3) rows.push([s.uuid, "Test Guest iPhone", "", null, istIso(s.date, s.time, 5), istIso(s.date, s.time, 55)]);
    }
  }
  await insertMany(db(), "zoom_instances", ["uuid", "batch_meeting_id", "meeting_id", "zoom_account", "start_time", "end_time", "report_synced_at"], instances);
  await insertMany(db(), "zoom_participants", ["instance_uuid", "name", "email", "registrant_id", "join_time", "leave_time"], rows);
  await q(`INSERT INTO dnc (key, note) VALUES ('phone:9000000006', 'TEST: asked to stop reminders') ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO sync_runs (source, finished_at, status, records, note) VALUES ('TEST data', now(), 'Synced', $1, 'Sample data loaded by scripts/test-data.js')`, [rows.length]);

  console.log(`Loaded TEST data: 10 learners, batch starting ${START} (weeks 1–4 held), ${instances.length} sessions, ${rows.length} join/leave rows.`);
}

const mode = process.argv[2] === "clear" ? "clear" : "load";
await initDb();
await ensureFirstAdmin();
if (mode === "clear") { await clear(); console.log("Removed all TEST data."); }
else await load();
await db().close();
