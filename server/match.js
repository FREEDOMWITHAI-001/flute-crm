// Identity normalisation and Zoom → learner matching.
// Order of trust: registrant / Zoom email → phone → a decision someone made by hand.
// Name-only matches are never automatic; they only produce suggestions for the review queue.

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

/** Index learners for O(1) email / phone lookups. */
export function buildLearnerIndex(learners) {
  const byEmail = new Map();
  const byPhone = new Map();
  const byId = new Map();
  for (const l of learners) {
    byId.set(l.id, l);
    const e = normEmail(l.email);
    if (e && !byEmail.has(e)) byEmail.set(e, l);
    const p = phoneKey(l.phone);
    if (p && !byPhone.has(p)) byPhone.set(p, l);
  }
  return { byEmail, byPhone, byId, all: learners };
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
  const p = phoneKey(phone);
  if (p && index.byPhone.has(p)) {
    const l = index.byPhone.get(p);
    return { personKey: `learner:${l.id}`, learnerId: l.id, via: "phone", excluded: false, identityKey };
  }
  return { personKey: identityKey, learnerId: null, via: "none", excluded: false, identityKey };
}

/** Up to `limit` learner suggestions for an unmatched Zoom identity, best first. */
export function suggestLearners({ name, email }, learners, { limit = 3, minConfidence = 40 } = {}) {
  const zTokens = nameTokens(name);
  const emailLocal = normEmail(email).split("@")[0] || "";
  const emailTokens = emailLocal.split(/[._\-+0-9]+/).filter(t => t.length > 2);
  if (!zTokens.length && !emailTokens.length) return [];

  const out = [];
  for (const l of learners) {
    const lTokens = nameTokens(l.name);
    if (!lTokens.length) continue;
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

    const lEmailLocal = normEmail(l.email).split("@")[0] || "";
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
