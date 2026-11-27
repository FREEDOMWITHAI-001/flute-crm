// Paid learners: TagMango order/refund webhooks, CSV imports of past buyers,
// and an optional pull endpoint (TagMango does not document a "list orders" API).
import { q, q1 } from "./db.js";
import { normEmail, normPhone, phoneKey } from "./match.js";

const TAGMANGO_API = "https://api-prod-new.tagmango.com";
export const WEBHOOK_EVENTS = ["order.created.completed", "order.refund.initiated"];

// ---------- Field extraction (payload shapes vary, so look for fields by name) ----------
function leaves(obj, prefix = "", out = []) {
  if (obj == null) return out;
  if (typeof obj !== "object") { out.push([prefix, obj]); return out; }
  if (Array.isArray(obj)) { obj.slice(0, 5).forEach((v, i) => leaves(v, `${prefix}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(obj)) leaves(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
}

const lastKey = path => path.split(".").pop().replace(/\[\d+\]$/, "").toLowerCase();
const pick = (pairs, test, valid = v => v !== "" && v != null) => {
  for (const [path, v] of pairs) if (test(lastKey(path), path) && valid(v)) return v;
  return null;
};

/** Pull learner fields out of any TagMango-ish object or CSV row object. */
export function extractLearner(record) {
  const pairs = leaves(record);
  const email = pick(pairs, k => /e-?mail/.test(k), v => !!normEmail(v));
  const phone = pick(pairs, k => /(phone|mobile|contact|whatsapp)/.test(k) && !/code$/.test(k), v => normPhone(v).length >= 8);
  const dialCode = pick(pairs, k => /(dial|country)_?code$/.test(k));
  let name = pick(pairs, k => /^(name|full_?name|fullname|customer_?name|user_?name|fan_?name|buyer_?name|student_?name)$/.test(k), v => typeof v === "string");
  if (!name) {
    const first = pick(pairs, k => /^first_?name$/.test(k));
    const last = pick(pairs, k => /^last_?name$/.test(k));
    name = [first, last].filter(Boolean).join(" ") || null;
  }
  const country = pick(pairs, k => /^country(_?name)?$/.test(k), v => typeof v === "string" && v.length > 1);
  const date = pick(pairs, k => /(paid|payment|order|purchase|created|transaction).*(at|date|time|on)$|^date$/.test(k), v => !Number.isNaN(Date.parse(v)));
  const product = pick(pairs, k => /^(mango|mango_?name|product|product_?name|course|course_?name|title|plan)$/.test(k), v => typeof v === "string");
  const status = pick(pairs, k => /^(status|payment_?status|order_?status)$/.test(k), v => typeof v === "string");
  const orderId = pick(pairs, k => /^(order_?id|orderid|_id|id|transaction_?id|payment_?id)$/.test(k));

  let fullPhone = phone ? String(phone) : "";
  if (fullPhone && dialCode && !String(fullPhone).startsWith("+") && String(fullPhone).replace(/\D/g, "").length === 10 && String(dialCode).replace(/\D/g, "") !== "91") {
    fullPhone = `+${String(dialCode).replace(/\D/g, "")}${fullPhone}`;
  }
  return {
    email: normEmail(email),
    phone: fullPhone ? (normPhone(fullPhone) ? "+" + normPhone(fullPhone) : fullPhone) : "",
    name: name ? String(name).trim() : "",
    country: country ? String(country).trim() : "",
    paymentDate: date ? new Date(date).toISOString().slice(0, 10) : null,
    product: product ? String(product) : "",
    status: status ? String(status) : "",
    orderId: orderId != null ? String(orderId) : ""
  };
}

export function isRefund(eventName, fields) {
  return /refund/i.test(eventName || "") || /refund/i.test(fields.status || "");
}

/** Insert or update one learner. Returns { id, inserted } or null when there's nothing to key on. */
export async function upsertLearner(fields, { platform = "TagMango", refunded = false, raw = null } = {}) {
  const sourceKey = fields.email ? `email:${fields.email}` : (phoneKey(fields.phone) ? `phone:${phoneKey(fields.phone)}` : null);
  if (!sourceKey) return null;
  const row = await q1(
    `INSERT INTO learners (source_key, name, email, phone, country, payment_date, platform, product, status, raw, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
     ON CONFLICT (source_key) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), learners.name),
       email = COALESCE(NULLIF(EXCLUDED.email, ''), learners.email),
       phone = COALESCE(NULLIF(EXCLUDED.phone, ''), learners.phone),
       country = COALESCE(NULLIF(EXCLUDED.country, ''), learners.country),
       payment_date = LEAST(learners.payment_date, EXCLUDED.payment_date),
       platform = COALESCE(learners.platform, EXCLUDED.platform),
       product = COALESCE(NULLIF(EXCLUDED.product, ''), learners.product),
       status = CASE WHEN $11 THEN 'refunded' ELSE learners.status END,
       raw = COALESCE(EXCLUDED.raw, learners.raw),
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [sourceKey, fields.name || "", fields.email || "", fields.phone || "", fields.country || "", fields.paymentDate,
     platform, fields.product || "", refunded ? "refunded" : "paid", raw ? JSON.stringify(raw) : null, refunded]
  );
  return row;
}

// ---------- Webhook ----------
export async function handleWebhook(payload) {
  const eventName = payload?.event || payload?.type || payload?.eventName || payload?.trigger || "";
  const fields = extractLearner(payload?.data ?? payload);
  const ev = await q1(`INSERT INTO tagmango_events (event, payload) VALUES ($1, $2) RETURNING id`, [eventName, JSON.stringify(payload)]);
  if (/failed|initiated$/i.test(eventName) && !/refund/i.test(eventName)) {
    return { stored: ev.id, learner: null, ignored: "not a completed payment" };
  }
  const res = await upsertLearner(fields, { refunded: isRefund(eventName, fields), raw: payload });
  if (!res) await q(`UPDATE tagmango_events SET error = $2 WHERE id = $1`, [ev.id, "No email or phone in payload"]);
  else await q(`UPDATE tagmango_events SET learner_id = $2 WHERE id = $1`, [ev.id, res.id]);
  return { stored: ev.id, learner: res?.id ?? null };
}

export async function registerWebhooks({ apiKey = process.env.TAGMANGO_API_KEY, hookUrl, fetchImpl = fetch } = {}) {
  if (!apiKey) throw new Error("TAGMANGO_API_KEY is not set");
  if (!hookUrl) throw new Error("PUBLIC_URL is not set, so TagMango has no address to send events to");
  const results = [];
  for (const event of WEBHOOK_EVENTS) {
    const res = await fetchImpl(`${TAGMANGO_API}/api/v1/integration/webhook/webhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ hookUrl, event, ...(process.env.TAGMANGO_MANGO_ID ? { mango: process.env.TAGMANGO_MANGO_ID } : {}) })
    });
    const body = await res.json().catch(() => ({}));
    results.push({ event, ok: res.ok && body.success !== false, message: body.message || res.statusText });
  }
  return results;
}

// ---------- Subscribers API (read-only: "This POST performs a read and is safe to retry") ----------
const TM_EXTERNAL = `${TAGMANGO_API}/api/v1/external`;
const PAGE_SIZE = 100; // the API rejects larger pages
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** One subscriber row → learner fields. A person holds one row with all their products. */
export function subscriberToLearner(row) {
  const c = row.customer || {};
  let phone = c.phone ? String(c.phone).trim() : "";
  if (phone && !phone.startsWith("+") && row.dialCode) phone = `${row.dialCode}${phone}`;
  const orderDates = (row.orders || []).map(o => o.orderedAt).filter(Boolean).sort();
  const paid = orderDates[0] || row.subscribedAt || row.createdAt || null;
  return {
    email: normEmail(c.email),
    phone: normPhone(phone) ? "+" + normPhone(phone) : phone,
    name: c.name ? String(c.name).trim() : "",
    country: c.country || "",
    paymentDate: paid ? new Date(paid).toISOString().slice(0, 10) : null,
    product: (row.mangoes || []).map(m => m.title).filter(Boolean).join(" · ").slice(0, 500),
    // "revoked" = access taken away (refunds, removals); expired members still paid at some point
    refunded: row.status === "revoked",
    externalId: c._id || row.id
  };
}

async function tmPost(path, body, { apiKey, host, fetchImpl }) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchImpl(`${TM_EXTERNAL}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "x-whitelabel-host": host, "x-timezone-offset": "330", "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (res.status === 429 && attempt < 6) { await sleep(11_000); continue; } // "try after 10 seconds"
    if (res.status >= 500 && attempt < 3) { await sleep(2000 * (attempt + 1)); continue; }
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.success === false) throw new Error(`TagMango ${res.status}: ${json.message || res.statusText}`);
    return json.result ?? json;
  }
}

/** Upsert a batch of learners in one statement; the API is the source of truth for status. */
async function upsertLearnerBatch(list) {
  const rows = [];
  const seen = new Set();
  for (const f of list) {
    const key = f.email ? `email:${f.email}` : (phoneKey(f.phone) ? `phone:${phoneKey(f.phone)}` : null);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    rows.push([key, f.name || "", f.email || "", f.phone || "", f.country || "", f.paymentDate, "TagMango", f.product || "", f.refunded ? "refunded" : "paid"]);
  }
  if (!rows.length) return 0;
  const params = [];
  const values = rows.map(r => `(${r.map(v => { params.push(v); return `$${params.length}`; }).join(",")}, now())`);
  await q(
    `INSERT INTO learners (source_key, name, email, phone, country, payment_date, platform, product, status, updated_at)
     VALUES ${values.join(",")}
     ON CONFLICT (source_key) DO UPDATE SET
       name = COALESCE(NULLIF(EXCLUDED.name, ''), learners.name),
       email = COALESCE(NULLIF(EXCLUDED.email, ''), learners.email),
       phone = COALESCE(NULLIF(EXCLUDED.phone, ''), learners.phone),
       country = COALESCE(NULLIF(EXCLUDED.country, ''), learners.country),
       payment_date = LEAST(learners.payment_date, EXCLUDED.payment_date),
       product = COALESCE(NULLIF(EXCLUDED.product, ''), learners.product),
       status = EXCLUDED.status,
       updated_at = now()`, params);
  return rows.length;
}

/**
 * Pull subscribers from TagMango into learners.
 * full: every subscriber (≈350 pages). Otherwise only people who subscribed in the last `sinceDays`.
 */
export async function syncSubscribers({ full = false, sinceDays = 3, apiKey = process.env.TAGMANGO_API_KEY, host = process.env.TAGMANGO_HOST,
  fetchImpl = fetch, now = new Date(), maxPages = 2000 } = {}) {
  if (!apiKey || !host) return { skipped: true, reason: "TAGMANGO_API_KEY or TAGMANGO_HOST not set" };
  const body = { status: "all", limit: PAGE_SIZE };
  if (!full) {
    body.subscribedAfter = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
    body.subscribedBefore = now.toISOString();
  }
  let page = 1, fetched = 0, saved = 0, total = null;
  for (; page <= maxPages; page++) {
    const result = await tmPost("/subscribers", { ...body, page }, { apiKey, host, fetchImpl });
    const data = result.data || [];
    if (page === 1 && typeof result.total === "number") total = result.total;
    if (!data.length) break;
    fetched += data.length;
    saved += await upsertLearnerBatch(data.map(subscriberToLearner));
    if (data.length < PAGE_SIZE) break;
  }
  return { full, fetched, saved, total, pages: page };
}

// ---------- Optional pull (only if Ganesh's TagMango access exposes a list endpoint) ----------
export async function pullLearners({ url = process.env.TAGMANGO_PULL_URL, apiKey = process.env.TAGMANGO_API_KEY, fetchImpl = fetch } = {}) {
  if (!url) return { skipped: true, reason: "TAGMANGO_PULL_URL not set" };
  const res = await fetchImpl(url, { headers: { "x-api-key": apiKey || "", Accept: "application/json" } });
  if (!res.ok) throw new Error(`TagMango ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = await res.json();
  const list = Array.isArray(body) ? body : (body.result?.data || body.data || body.result || body.orders || []);
  let inserted = 0, updated = 0, skipped = 0;
  for (const rec of Array.isArray(list) ? list : []) {
    const f = extractLearner(rec);
    const r = await upsertLearner(f, { refunded: isRefund("", f), raw: rec });
    if (!r) skipped++; else if (r.inserted) inserted++; else updated++;
  }
  return { inserted, updated, skipped };
}

// ---------- CSV import ----------
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text || "").replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some(v => v.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some(v => v.trim() !== "")) rows.push(row);
  return rows;
}

export async function importCsv(csvText, { platform = "TagMango" } = {}) {
  const rows = parseCsv(csvText);
  if (rows.length < 2) return { inserted: 0, updated: 0, skipped: 0, errors: ["The file has no data rows"] };
  const headers = rows[0].map(h => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  let inserted = 0, updated = 0, skipped = 0;
  const errors = [];
  for (let i = 1; i < rows.length; i++) {
    const obj = Object.fromEntries(headers.map((h, j) => [h || `col${j}`, (rows[i][j] ?? "").trim()]));
    const f = extractLearner(obj);
    try {
      const r = await upsertLearner(f, { platform, refunded: isRefund("", f), raw: obj });
      if (!r) { skipped++; if (errors.length < 20) errors.push(`Row ${i + 1}: no email or phone`); }
      else if (r.inserted) inserted++; else updated++;
    } catch (e) {
      skipped++;
      if (errors.length < 20) errors.push(`Row ${i + 1}: ${e.message}`);
    }
  }
  return { inserted, updated, skipped, errors };
}
