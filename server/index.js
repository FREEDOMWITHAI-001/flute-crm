import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { initDb, q, q1 } from "./db.js";
import { login, logout, loadUser, requireRole, publicUser, ensureFirstAdmin, hashPassword } from "./auth.js";
import * as store from "./store.js";
import { loadZoomAccounts, parseMeetingRef } from "./zoom.js";
import { syncZoom } from "./sync.js";
import { handleWebhook, importCsv, registerWebhooks, pullLearners, syncSubscribers } from "./tagmango.js";
import { normEmail, phoneKey } from "./match.js";
import { weekday } from "./time.js";
import { SLOTS } from "./model.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ADMIN = requireRole("Admin");

// Wrap async handlers so thrown errors reach the error middleware.
const h = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function webhookUrl() {
  const base = (process.env.PUBLIC_URL || "").replace(/\/$/, "");
  return base && process.env.TAGMANGO_WEBHOOK_SECRET ? `${base}/api/webhooks/tagmango?secret=${process.env.TAGMANGO_WEBHOOK_SECRET}` : null;
}

// ---------- Sync orchestration ----------
let syncing = false;
// Lease in the DB so two serverless instances (cron + "Sync now") never sync at once.
const LOCK_MINUTES = 6;
async function acquireSyncLock() {
  const row = await q1(
    `INSERT INTO settings (key, value) VALUES ('sync_lock', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
       WHERE (settings.value->>'until')::timestamptz < now()
     RETURNING key`,
    [JSON.stringify({ until: new Date(Date.now() + LOCK_MINUTES * 60_000).toISOString() })]);
  return !!row;
}
const releaseSyncLock = () => q(`DELETE FROM settings WHERE key = 'sync_lock'`);

const saveSetting = (key, value) =>
  q(`INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key, JSON.stringify(value)]);

/**
 * opts.scheduled  — from cron: also runs (or continues) the daily full TagMango refresh
 * opts.deadline   — epoch ms; the full refresh pauses there and resumes on the next scheduled run
 */
export async function runSync(source = "all", opts = {}) {
  if (syncing || !(await acquireSyncLock())) return { skipped: true, reason: "A sync is already running" };
  syncing = true;
  const results = {};
  try {
    if (source === "all" || source === "zoom") {
      results.zoom = await syncZoom({ accounts: loadZoomAccounts() });
    }
    if ((source === "all" || source === "tagmango") && process.env.TAGMANGO_API_KEY && process.env.TAGMANGO_HOST) {
      // Every sync pulls recent subscribers (seconds). The full refresh (~13 min, catches refunds/revocations)
      // runs once a day from the scheduled sync only, in deadline-sized chunks that resume via a saved cursor.
      const last = await q1(`SELECT value FROM settings WHERE key = 'tagmango_last_full'`);
      const cursor = (await q1(`SELECT value FROM settings WHERE key = 'tagmango_full_cursor'`))?.value;
      const due = !last || Date.now() - new Date(last.value.at).getTime() > 20 * 3600_000;
      const full = opts.fullTagMango || (opts.scheduled && (due || !!cursor));
      const run = await q1(`INSERT INTO sync_runs (source) VALUES ('TagMango') RETURNING id`);
      try {
        const recent = await syncSubscribers({ full: false });
        let note = `Recent subscribers: ${recent.fetched.toLocaleString("en-US")} rows · ${recent.saved.toLocaleString("en-US")} learners saved`;
        let saved = recent.saved;
        const r = { recent };
        if (full) {
          const startPage = cursor?.page || 1;
          const f = await syncSubscribers({ full: true, startPage, deadline: opts.deadline ?? Infinity });
          r.full = f;
          saved += f.saved;
          const soFar = (startPage > 1 ? cursor.saved || 0 : 0) + f.saved;
          if (f.done) {
            await saveSetting("tagmango_last_full", { at: new Date().toISOString(), saved: soFar });
            await q(`DELETE FROM settings WHERE key = 'tagmango_full_cursor'`);
            note += ` · Full refresh finished (${soFar.toLocaleString("en-US")} learners)`;
          } else {
            await saveSetting("tagmango_full_cursor", { page: f.nextPage, saved: soFar, startedAt: cursor?.startedAt || new Date().toISOString() });
            note += ` · Full refresh in progress: page ${f.nextPage - 1}${f.total ? ` of ${Math.ceil(f.total / 100)}` : ""}, continues next sync`;
          }
        }
        await q(`UPDATE sync_runs SET finished_at = now(), status = 'Synced', records = $2, note = $3 WHERE id = $1`, [run.id, saved, note]);
        results.tagmango = r;
      } catch (e) {
        await q(`UPDATE sync_runs SET finished_at = now(), status = 'Sync failed', error = $2 WHERE id = $1`, [run.id, e.message]);
        results.tagmango = { error: e.message };
      }
    } else if ((source === "all" || source === "tagmango") && process.env.TAGMANGO_PULL_URL) {
      const r = await pullLearners();
      results.tagmango = r;
    } else if (source === "tagmango") {
      results.tagmango = { skipped: true, reason: "TAGMANGO_API_KEY / TAGMANGO_HOST not set; use Import CSV instead." };
    }
    return results;
  } finally {
    syncing = false;
    await releaseSyncLock().catch(() => {});
    store.invalidate();
  }
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" }));

  // Scheduled sync (Vercel Cron / Supabase pg_cron). Vercel functions stop at 300 s, so the
  // TagMango full refresh gets a deadline and resumes on the next call.
  app.all("/api/cron/sync", h(async (req, res) => {
    const secret = process.env.CRON_SECRET;
    const given = String(req.headers.authorization || "").replace(/^Bearer /, "");
    if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return res.status(401).json({ error: "unauthorized" });
    }
    res.json({ results: await runSync("all", { scheduled: true, deadline: Date.now() + 200_000 }) });
  }));

  // Public: TagMango webhook (secret in the URL because TagMango doesn't sign requests)
  app.post("/api/webhooks/tagmango", h(async (req, res) => {
    const secret = process.env.TAGMANGO_WEBHOOK_SECRET;
    const given = String(req.query.secret || "");
    if (!secret || given.length !== secret.length || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(secret))) {
      return res.status(401).json({ error: "bad secret" });
    }
    const out = await handleWebhook(req.body);
    store.invalidate();
    res.json({ ok: true, ...out });
  }));

  app.use("/api", loadUser);
  app.post("/api/auth/login", h(login));
  app.post("/api/auth/logout", h(logout));
  app.get("/api/auth/me", requireRole(), (req, res) => res.json({ user: publicUser(req.user) }));

  // ---------- Read ----------
  app.get("/api/bootstrap", requireRole(), h(async (req, res) => {
    const isAdmin = req.user.role === "Admin";
    const defaultBatchId = await store.defaultBatchId();
    res.json({
      user: publicUser(req.user),
      meta: { today: await store.today(), lastSyncedIso: await store.lastSyncedIso(), goalRetentionPct: 60, baselineRetentionPct: 48 },
      rules: await store.getRules(),
      batches: await store.batchSummaries(),
      defaultBatchId,
      sync: { sources: await store.syncSources(), alerts: req.user.role === "Team member" ? [] : await store.alerts(defaultBatchId) },
      unmatchedCount: isAdmin ? await store.unmatchedCount() : 0
    });
  }));

  const withBatch = fn => h(async (req, res) => {
    const model = await store.getBatchModel(Number(req.params.id));
    if (!model) return res.status(404).json({ error: "Batch not found" });
    return fn(req, res, model);
  });

  app.get("/api/batches/:id/overview", requireRole("Admin", "Viewer"), h(async (req, res) => {
    const out = await store.overview(Number(req.params.id));
    if (!out) return res.status(404).json({ error: "Batch not found" });
    res.json(out);
  }));
  app.get("/api/batches/:id/sessions", ADMIN, withBatch((req, res, m) => res.json({ sessions: m.sessions })));
  app.get("/api/sessions/:id", ADMIN, h(async (req, res) => {
    const s = await store.sessionDetail(req.params.id);
    if (!s) return res.status(404).json({ error: "Session not found" });
    const label = loadZoomAccounts().find(a => a.key === s.zoomAccount)?.label || s.zoomAccount;
    res.json({ ...s, zoomAccountLabel: label });
  }));
  app.get("/api/batches/:id/learners", ADMIN, withBatch((req, res, m) => res.json({ learners: m.learners })));
  app.get("/api/learners/search", ADMIN, h(async (req, res) => {
    const term = `%${String(req.query.q || "").trim()}%`;
    if (term.length < 4) return res.json({ results: [] });
    const results = await q(
      `SELECT id, name, email, phone FROM learners
        WHERE name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 ORDER BY name LIMIT 20`, [term]);
    res.json({ results });
  }));
  app.get("/api/learners/:id", ADMIN, h(async (req, res) => {
    const p = await store.learnerProfile(Number(req.params.id), Number(req.query.batchId));
    if (!p) return res.status(404).json({ error: "Learner not found" });
    res.json(p);
  }));
  app.get("/api/batches/:id/journey", requireRole("Admin", "Viewer"), h(async (req, res) => {
    const out = await store.journey(Number(req.params.id));
    if (!out) return res.status(404).json({ error: "Batch not found" });
    res.json(out);
  }));
  app.get("/api/batches/:id/lists", requireRole("Admin", "Team member"), h(async (req, res) => {
    const out = await store.lists(Number(req.params.id));
    if (!out) return res.status(404).json({ error: "Batch not found" });
    // Latest call per learner, so the call list shows who has already been called
    const calls = await q(
      `SELECT DISTINCT ON (learner_id) learner_id AS "learnerId", outcome, reason, follow_up::text AS "followUp",
              caller_name AS "callerName", called_at AS "calledAt",
              count(*) OVER (PARTITION BY learner_id)::int AS "callCount"
         FROM call_logs ORDER BY learner_id, called_at DESC`);
    res.json({ ...out, calls: Object.fromEntries(calls.map(c => [c.learnerId, c])) });
  }));

  // ---------- Call outcomes (a person calls; the reason is logged; attendance is never rewritten) ----------
  const CALL_OUTCOMES = ["Reached – will rejoin", "Reached – call back later", "Reached – not continuing", "No answer", "Wrong or invalid number", "Asked not to be called"];
  const CALL_REASONS = ["Busy / schedule clash", "Health or personal", "Zoom / technical trouble", "Finds it too hard", "Lost interest", "Joins with another email", "Other"];
  app.get("/api/calls/options", requireRole("Admin", "Team member"), (req, res) => res.json({ outcomes: CALL_OUTCOMES, reasons: CALL_REASONS }));
  app.get("/api/learners/:id/calls", requireRole("Admin", "Team member"), h(async (req, res) => {
    res.json({ calls: await q(
      `SELECT id, outcome, reason, follow_up::text AS "followUp", note, caller_name AS "callerName", called_at AS "calledAt", phase, batch_id AS "batchId"
         FROM call_logs WHERE learner_id = $1 ORDER BY called_at DESC`, [Number(req.params.id)]) });
  }));
  app.post("/api/calls", requireRole("Admin", "Team member"), h(async (req, res) => {
    const b = req.body || {};
    const learner = await q1(`SELECT id, email, phone FROM learners WHERE id = $1`, [Number(b.learnerId)]);
    if (!learner) throw bad("Learner not found", 404);
    if (!CALL_OUTCOMES.includes(b.outcome)) throw bad("Pick an outcome");
    if (b.reason && !CALL_REASONS.includes(b.reason)) throw bad("Unknown reason");
    if (b.followUp && !/^\d{4}-\d{2}-\d{2}$/.test(b.followUp)) throw bad("Follow-up date must be YYYY-MM-DD");
    const row = await q1(
      `INSERT INTO call_logs (learner_id, batch_id, phase, caller_id, caller_name, outcome, reason, follow_up, note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [learner.id, b.batchId ? Number(b.batchId) : null, b.phase || null, req.user.id, req.user.name || req.user.email,
       b.outcome, b.reason || null, b.followUp || null, String(b.note || "").slice(0, 1000) || null]);
    // "Asked not to be called" goes straight onto the do-not-contact list
    if (b.outcome === "Asked not to be called") {
      for (const key of [normEmail(learner.email) && `email:${normEmail(learner.email)}`, phoneKey(learner.phone) && `phone:${phoneKey(learner.phone)}`].filter(Boolean)) {
        await q(`INSERT INTO dnc (key, note) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`, [key, `Asked on a call (${req.user.name || req.user.email})`]);
      }
      store.invalidate();
    }
    res.json({ id: row.id });
  }));
  app.get("/api/batches/:id/review", ADMIN, h(async (req, res) => {
    const items = await store.reviewItems(Number(req.params.id));
    if (!items) return res.status(404).json({ error: "Batch not found" });
    res.json({ items });
  }));
  app.get("/api/sync", ADMIN, h(async (req, res) => {
    res.json({ sources: await store.syncSources(), alerts: await store.alerts(await store.defaultBatchId()), logs: await store.syncLogs() });
  }));
  app.get("/api/settings", ADMIN, h(async (req, res) => {
    const batches = (await q(`SELECT id, name, to_char(start_date, 'YYYY-MM-DD') AS "startDate", break_weeks AS "breakWeeksJson" FROM batches ORDER BY start_date DESC`))
      .map(({ breakWeeksJson, ...b }) => { let breakWeeks = []; try { breakWeeks = JSON.parse(breakWeeksJson || "[]"); } catch { /* ignore */ } return { ...b, breakWeeks }; });
    const meetings = await q(
      `SELECT id, batch_id AS "batchId", slot, zoom_account AS "zoomAccount", meeting_id AS "meetingId",
              registration_url AS "registrationUrl", topic, start_time AS "startTime", duration_min AS "durationMin",
              resolve_error AS "resolveError" FROM batch_meetings ORDER BY id`);
    const summaries = new Map((await store.batchSummaries()).map(b => [b.id, b]));
    const tm = await q1(`SELECT count(*)::int AS n FROM learners`);
    const lastEvent = await q1(`SELECT max(received_at) AS t FROM tagmango_events`);
    res.json({
      rules: await store.getRules(),
      batches: batches.map(b => ({ ...b, status: summaries.get(b.id)?.status, meetings: meetings.filter(m => m.batchId === b.id) })),
      zoomAccounts: loadZoomAccounts().map(({ key, label, connected }) => ({ key, label, connected })),
      team: await q(`SELECT id, name, email, role, active FROM users ORDER BY id`),
      dnc: (await q(`SELECT key, note, added_at FROM dnc ORDER BY added_at DESC`)).map(r => ({ key: r.key, note: r.note || "", addedAt: new Date(r.added_at).toISOString() })),
      tagmango: {
        webhookUrl: webhookUrl(), apiKeyConfigured: !!process.env.TAGMANGO_API_KEY, pullConfigured: !!process.env.TAGMANGO_PULL_URL,
        learnersCount: tm.n, lastEventIso: lastEvent?.t ? new Date(lastEvent.t).toISOString() : null
      }
    });
  }));

  // ---------- Write ----------
  app.post("/api/review/resolve", ADMIN, h(async (req, res) => {
    const { identityKey, action, learnerId } = req.body || {};
    if (!identityKey || !["match", "not_learner", "skip"].includes(action)) throw bad("identityKey and a valid action are required");
    if (action === "match" && !(await q1(`SELECT id FROM learners WHERE id = $1`, [Number(learnerId)]))) throw bad("Unknown learner");
    await q(
      `INSERT INTO identity_links (identity_key, decision, learner_id, decided_by, decided_at) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (identity_key) DO UPDATE SET decision = EXCLUDED.decision, learner_id = EXCLUDED.learner_id,
         decided_by = EXCLUDED.decided_by, decided_at = now()`,
      [identityKey, action, action === "match" ? Number(learnerId) : null, req.user.id]);
    store.invalidate();
    res.json({ ok: true });
  }));

  app.post("/api/sync/run", ADMIN, h(async (req, res) => {
    const source = ["zoom", "tagmango", "all"].includes(req.body?.source) ? req.body.source : "all";
    res.json({ results: await runSync(source) });
  }));

  app.put("/api/settings/rules", ADMIN, h(async (req, res) => res.json({ rules: await store.saveRules(req.body?.rules || {}) })));

  app.post("/api/batches", ADMIN, h(async (req, res) => {
    const startDate = String(req.body?.startDate || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || weekday(startDate) !== 0) throw bad("Start date must be a Sunday (YYYY-MM-DD)");
    if (await q1(`SELECT id FROM batches WHERE start_date = $1`, [startDate])) throw bad("A batch already starts on that date");
    const b = await q1(`INSERT INTO batches (name, start_date) VALUES ($1, $2) RETURNING id`, [req.body?.name || null, startDate]);
    store.invalidate();
    res.json({ id: b.id });
  }));
  app.put("/api/batches/:id", ADMIN, h(async (req, res) => {
    const { name, startDate, breakWeeks } = req.body || {};
    if (startDate && (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || weekday(startDate) !== 0)) throw bad("Start date must be a Sunday");
    let breaksJson = null;
    if (breakWeeks !== undefined) {
      if (!Array.isArray(breakWeeks)) throw bad("breakWeeks must be a list of Sundays");
      const clean = [...new Set(breakWeeks.map(String).map(s => s.trim()).filter(Boolean))].sort();
      for (const d of clean) if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || weekday(d) !== 0) throw bad(`Break weeks are Sundays (YYYY-MM-DD); ${d} isn't`);
      if (clean.length > 4) throw bad("At most 4 break weeks per batch");
      breaksJson = JSON.stringify(clean);
    }
    await q(`UPDATE batches SET name = COALESCE($2, name), start_date = COALESCE($3::date, start_date), break_weeks = COALESCE($4, break_weeks) WHERE id = $1`,
      [Number(req.params.id), name ?? null, startDate || null, breaksJson]);
    store.invalidate();
    res.json({ ok: true });
  }));
  app.delete("/api/batches/:id", ADMIN, h(async (req, res) => {
    await q(`DELETE FROM batches WHERE id = $1`, [Number(req.params.id)]);
    store.invalidate();
    res.json({ ok: true });
  }));

  const meetingFields = (body, { partial = false } = {}) => {
    const accounts = loadZoomAccounts().map(a => a.key);
    const out = {};
    if (!partial || body.slot !== undefined) {
      if (!SLOTS[body.slot]) throw bad("slot must be learning_p1, learning_p2, practice_p1 or practice_p2");
      out.slot = body.slot;
    }
    if (!partial || body.zoomAccount !== undefined) {
      if (!accounts.includes(body.zoomAccount)) throw bad(`zoomAccount must be one of ${accounts.join(", ")}`);
      out.zoom_account = body.zoomAccount;
    }
    if (!partial || body.ref !== undefined) {
      const ref = parseMeetingRef(String(body.ref || ""));
      if (!ref) throw bad("Enter a numeric Zoom meeting ID or a Zoom meeting/registration link");
      out.meeting_id = ref.meetingId || null;
      out.registration_url = ref.registrationUrl || null;
      out.topic = null;
      out.resolve_error = null;
    }
    if (body.startTime !== undefined) {
      if (body.startTime && !/^\d{2}:\d{2}$/.test(body.startTime)) throw bad("startTime must be HH:MM");
      out.start_time = body.startTime || null;
    }
    if (body.durationMin !== undefined) out.duration_min = body.durationMin ? Number(body.durationMin) : null;
    return out;
  };
  app.post("/api/batches/:id/meetings", ADMIN, h(async (req, res) => {
    const f = meetingFields(req.body || {});
    const cols = ["batch_id", ...Object.keys(f)];
    const vals = [Number(req.params.id), ...Object.values(f)];
    const row = await q1(`INSERT INTO batch_meetings (${cols.join(",")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals);
    store.invalidate();
    res.json({ id: row.id });
  }));
  app.put("/api/meetings/:id", ADMIN, h(async (req, res) => {
    const f = meetingFields(req.body || {}, { partial: true });
    const keys = Object.keys(f);
    if (keys.length) {
      await q(`UPDATE batch_meetings SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [Number(req.params.id), ...Object.values(f)]);
    }
    store.invalidate();
    res.json({ ok: true });
  }));
  app.delete("/api/meetings/:id", ADMIN, h(async (req, res) => {
    await q(`DELETE FROM batch_meetings WHERE id = $1`, [Number(req.params.id)]);
    store.invalidate();
    res.json({ ok: true });
  }));

  const ROLES = ["Admin", "Team member", "Viewer"];
  app.post("/api/users", ADMIN, h(async (req, res) => {
    const { name, email, role, password } = req.body || {};
    const e = normEmail(email);
    if (!name || !e || !ROLES.includes(role)) throw bad("name, a valid email and a role are required");
    if (!password || String(password).length < 8) throw bad("Password must be at least 8 characters");
    if (await q1(`SELECT id FROM users WHERE email = $1`, [e])) throw bad("A user with that email already exists");
    const u = await q1(`INSERT INTO users (name, email, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`, [name, e, role, await hashPassword(password)]);
    res.json({ id: u.id });
  }));
  app.put("/api/users/:id", ADMIN, h(async (req, res) => {
    const id = Number(req.params.id);
    const { name, role, active, password } = req.body || {};
    if (role && !ROLES.includes(role)) throw bad("Unknown role");
    if (id === req.user.id && (role && role !== "Admin" || active === false)) throw bad("You can't remove your own admin access");
    if (password !== undefined && String(password).length < 8) throw bad("Password must be at least 8 characters");
    await q(
      `UPDATE users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
              password_hash = COALESCE($5, password_hash) WHERE id = $1`,
      [id, name ?? null, role ?? null, typeof active === "boolean" ? active : null, password ? await hashPassword(password) : null]);
    if (active === false || password) await q(`DELETE FROM auth_sessions WHERE user_id = $1`, [id]);
    res.json({ ok: true });
  }));
  app.delete("/api/users/:id", ADMIN, h(async (req, res) => {
    if (Number(req.params.id) === req.user.id) throw bad("You can't delete yourself");
    await q(`DELETE FROM users WHERE id = $1`, [Number(req.params.id)]);
    res.json({ ok: true });
  }));

  app.post("/api/dnc", ADMIN, h(async (req, res) => {
    let added = 0;
    for (const line of String(req.body?.values || "").split(/[\n,;]+/)) {
      const v = line.trim();
      if (!v) continue;
      const key = normEmail(v) ? `email:${normEmail(v)}` : (phoneKey(v).length >= 8 ? `phone:${phoneKey(v)}` : null);
      if (!key) continue;
      const r = await q(`INSERT INTO dnc (key, note) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`, [key, req.body?.note || null]);
      added += r.length;
    }
    store.invalidate();
    res.json({ added });
  }));
  app.delete("/api/dnc/:key", ADMIN, h(async (req, res) => {
    await q(`DELETE FROM dnc WHERE key = $1`, [req.params.key]);
    store.invalidate();
    res.json({ ok: true });
  }));

  app.post("/api/learners/import", ADMIN, h(async (req, res) => {
    if (!req.body?.csv) throw bad("csv is required");
    const out = await importCsv(req.body.csv, { platform: req.body.platform || "TagMango" });
    await q(`INSERT INTO sync_runs (source, finished_at, status, records, note) VALUES ('TagMango', now(), 'Synced', $1, $2)`,
      [out.inserted + out.updated, `CSV import: ${out.inserted} new · ${out.updated} updated · ${out.skipped} skipped`]);
    store.invalidate();
    res.json(out);
  }));
  app.post("/api/tagmango/register-webhooks", ADMIN, h(async (req, res) => {
    try {
      res.json({ results: await registerWebhooks({ hookUrl: webhookUrl() }) });
    } catch (e) {
      throw bad(e.message);
    }
  }));

  app.use("/api", (req, res) => res.status(404).json({ error: "Not found" }));
  app.use(express.static(path.join(ROOT, "public"), { index: "index.html" }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "Something went wrong on the server" : err.message });
  });
  return app;
}

function scheduleSync() {
  const minutes = Number(process.env.SYNC_INTERVAL_MINUTES || 60);
  if (!minutes) return;
  const tick = async () => {
    globalThis.__fgNextSyncAt = Date.now() + minutes * 60_000;
    try { await runSync("all", { scheduled: true }); } catch (e) { console.error("Scheduled sync failed:", e.message); }
  };
  globalThis.__fgNextSyncAt = Date.now() + 60_000;
  setTimeout(() => { tick(); setInterval(tick, minutes * 60_000); }, 60_000);
}

async function main() {
  await initDb();
  await ensureFirstAdmin();
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`Flute Gandharvas CRM on http://localhost:${port}`));
  scheduleSync();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
