// Identity normalisation and Zoom → learner matching.
// Order of trust: a decision someone made by hand → email (typos fixed) → phone → a full name that only one learner has.
// Partial or shared names are never auto-matched; they only produce suggestions for the review queue.

export function normEmail(email) {
  if (!email) return "";
  const e = String(email).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : "";
}

/** Digits with country code; Indian 10-digit mobiles get "91" prefixed. "" when unusable. */
export function normPhone(phone) {
  if (!phone) return "";
  let d = String(phone).replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10 && /^[6-9]/.test(d)) d = "91" + d;
  return d.length >= 8 ? d : "";
}

/** Key used to compare two phones: last 10 digits. */
export function phoneKey(phone) {
  const d = normPhone(phone);
  return d.length >= 10 ? d.slice(-10) : d;
}

export function normName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const NOISE_TOKENS = new Set([
  "iphone", "ipad", "android", "zoom", "user", "guest", "mobile", "phone", "samsung", "galaxy",
  "s", "the", "my", "pc", "laptop", "air", "pro", "mac", "macbook", "redmi", "oneplus", "vivo",
  "oppo", "realme", "nokia", "tab", "tablet", "flute", "bansuri", "practice", "mr", "mrs", "ms", "dr"
]);

export function nameTokens(name) {
  return normName(name).split(" ").filter(t => t.length > 1 && !NOISE_TOKENS.has(t) && !/^\d+$/.test(t));
}

export function regionFor({ phone, country } = {}) {
  const p = normPhone(phone);
  if (p) return p.startsWith("91") && p.length === 12 ? "India" : "Overseas";
  if (country) return /^(in|ind|india|bharat)$/i.test(String(country).trim()) ? "India" : "Overseas";
  return null;
}

/** Fix common domain typos people make when typing their email into Zoom (gmai.com, gmail.con, hotmsil.com…). */
export function fixEmailTypos(email) {
  const e = normEmail(email);
  if (!e) return "";
  return e
    .replace(/@(gmai|gmial|gmsil|gmqil|gmal|gamil|gnail|gmaill|g\.mail)\.(com|con|cpm|om|co|cm)$/, "@gmail.com")
    .replace(/@gmail\.(con|cpm|om|co|cm|comg)$/, "@gmail.com")
    .replace(/@(hotmsil|hitmail|hotmial|hotmil|hotmai)\.(com|con)$/, "@hotmail.com")
    .replace(/@(yahoo|hotmail|outlook|rediffmail|icloud)\.(con|cpm|om|cm)$/, "@$1.com")
    .replace(/\.(comm|coom|comn|xom|vom)$/, ".com");
}

/** Full-name key for name matching: needs 2+ real words ("Kumodini Jain", not "K M" or "Preeti"). */
export function fullNameKey(name) {
  const t = nameTokens(name);
  return t.length >= 2 && t.join("").length >= 6 ? t.join(" ") : "";
}

/** Index learners for O(1) email / phone / unique-full-name lookups. */
export function buildLearnerIndex(learners) {
  const byEmail = new Map();
  const byPhone = new Map();
  const byId = new Map();
  const byName = new Map(); // full name → learner, or null when two different learners share it
  for (const l of learners) {
    byId.set(l.id, l);
    const e = normEmail(l.email);
    if (e && !byEmail.has(e)) byEmail.set(e, l);
    const p = phoneKey(l.phone);
    if (p && !byPhone.has(p)) byPhone.set(p, l);
    const n = fullNameKey(l.name);
    if (n) byName.set(n, byName.has(n) && byName.get(n)?.id !== l.id ? null : l);
  }
  return { byEmail, byPhone, byName, byId, all: learners };
}

/**
 * Resolve one Zoom attendee to a person.
 * @returns {{ personKey, learnerId, via, excluded, identityKey }}
 */
export function resolveIdentity({ name, email, phone }, index, links) {
  const e = normEmail(email);
  const identityKey = e ? `email:${e}` : `name:${normName(name) || "unknown"}`;

  const link = links.get(identityKey);
  if (link && link.decision === "not_learner") {
    return { personKey: identityKey, learnerId: null, via: "excluded", excluded: true, identityKey };
  }
  if (link && link.decision === "match" && link.learnerId && index.byId.has(link.learnerId)) {
    return { personKey: `learner:${link.learnerId}`, learnerId: link.learnerId, via: "manual", excluded: false, identityKey };
  }
  if (e && index.byEmail.has(e)) {
    const l = index.byEmail.get(e);
    return { personKey: `learner:${l.id}`, learnerId: l.id, via: "email", excluded: false, identityKey };
  }
  const fixed = fixEmailTypos(e);
  if (fixed && fixed !== e && index.byEmail.has(fixed)) {
    const l = index.byEmail.get(fixed);
    return { personKey: `learner:${l.id}`, learnerId: l.id, via: "email", excluded: false, identityKey };
  }
  const p = phoneKey(phone);
  if (p && index.byPhone.has(p)) {
    const l = index.byPhone.get(p);
    return { personKey: `learner:${l.id}`, learnerId: l.id, via: "phone", excluded: false, identityKey };
  }
  // Last: the full name belongs to exactly one paid learner (spec: email, then phone, then name)
  const n = fullNameKey(name);
  const byName = n && index.byName ? index.byName.get(n) : null;
  if (byName) return { personKey: `learner:${byName.id}`, learnerId: byName.id, via: "name", excluded: false, identityKey };
  return { personKey: identityKey, learnerId: null, via: "none", excluded: false, identityKey };
}

// Name tokens / email local parts per learner list, computed once (the list has ~35k rows)
const preparedCache = new WeakMap();
function prepared(learners) {
  let p = preparedCache.get(learners);
  if (!p) {
    p = learners.map(l => ({ l, tokens: nameTokens(l.name), emailLocal: normEmail(l.email).split("@")[0] || "" })).filter(x => x.tokens.length);
    preparedCache.set(learners, p);
  }
  return p;
}

/** Up to `limit` learner suggestions for an unmatched Zoom identity, best first. */
export function suggestLearners({ name, email }, learners, { limit = 3, minConfidence = 40 } = {}) {
  const zTokens = nameTokens(name);
  const emailLocal = normEmail(email).split("@")[0] || "";
  const emailTokens = emailLocal.split(/[._\-+0-9]+/).filter(t => t.length > 2);
  if (!zTokens.length && !emailTokens.length) return [];

  const out = [];
  for (const { l, tokens: lTokens, emailLocal: lEmailLocal } of prepared(learners)) {
    let score = 0;
    const reasons = [];

    if (zTokens.length) {
      const shared = zTokens.filter(t => lTokens.includes(t));
      if (shared.length) {
        score += 70 * (shared.length / Math.max(zTokens.length, lTokens.length));
        if (zTokens[0] === lTokens[0]) { score += 20; reasons.push("first name matches"); }
        else reasons.push(`shares "${shared.join(" ")}"`);
        if (shared.length === lTokens.length && shared.length === zTokens.length) score += 15;
      } else if (zTokens.some(t => t.length >= 4 && lTokens.some(lt => lt.startsWith(t) || t.startsWith(lt)))) {
        score += 35;
        reasons.push("name starts the same");
      }
    }

    if (emailTokens.length && lEmailLocal) {
      const hits = emailTokens.filter(t => lEmailLocal.includes(t) || lTokens.includes(t));
      if (hits.length) { score += 25 * (hits.length / emailTokens.length); reasons.push("email looks similar"); }
    }

    const confidence = Math.min(99, Math.round(score));
    if (confidence >= minConfidence) {
      out.push({ learnerId: l.id, name: l.name, email: l.email || "", phone: l.phone || "", confidence, reason: reasons.join(" · ") || "similar name" });
    }
  }
  return out.sort((a, b) => b.confidence - a.confidence).slice(0, limit);
}
