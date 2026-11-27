// Zoom Server-to-Server OAuth client. One ZoomClient per Zoom account (we have two).
const API = "https://api.zoom.us/v2";
const TOKEN_URL = "https://zoom.us/oauth/token";
const MAX_ACCOUNTS = 5;
const MAX_PAGES = 1000;

/** Zoom accounts from env (ZOOM_1_* … ZOOM_5_*). Accounts 1 and 2 are always listed. */
export function loadZoomAccounts(env = process.env) {
  const out = [];
  for (let n = 1; n <= MAX_ACCOUNTS; n++) {
    const get = name => String(env[`ZOOM_${n}_${name}`] || "").trim();
    const accountId = get("ACCOUNT_ID");
    const clientId = get("CLIENT_ID");
    const clientSecret = get("CLIENT_SECRET");
    const label = get("LABEL");
    if (n > 1 && !accountId && !clientId && !clientSecret && !label) continue;
    out.push({
      key: `zoom${n}`,
      label: label || `Zoom account ${n}`,
      accountId,
      clientId,
      clientSecret,
      connected: Boolean(accountId && clientId && clientSecret)
    });
  }
  return out;
}

/**
 * What the user pasted for a meeting: a numeric ID, a join link, or a registration link.
 * → { meetingId } | { registrationUrl } | null
 */
export function parseMeetingRef(input) {
  const s = String(input ?? "").trim();
  if (!s) return null;
  if (/^[\d\s]+$/.test(s)) return { meetingId: s.replace(/\s/g, "") };
  if (!/zoom\.us\//i.test(s)) return null;
  if (/\/meeting\/register\/[^/?#\s]+/i.test(s)) return { registrationUrl: s };
  const join = s.match(/\/(?:j|w|s)\/(\d+)/i);
  if (join) return { meetingId: join[1] };
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export class ZoomClient {
  constructor({ accountId, clientId, clientSecret, fetchImpl = fetch, sleepImpl = sleep }) {
    this.accountId = accountId;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.fetch = fetchImpl;
    this.sleep = sleepImpl;
    this.accessToken = null;
    this.tokenExpiresAt = 0;
  }

  async token() {
    if (this.accessToken && Date.now() < this.tokenExpiresAt) return this.accessToken;
    const url = `${TOKEN_URL}?grant_type=account_credentials&account_id=${encodeURIComponent(this.accountId)}`;
    const basic = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString("base64");
    const res = await this.fetch(url, { method: "POST", headers: { Authorization: `Basic ${basic}` } });
    const text = await res.text();
    const body = parseJson(text);
    if (!res.ok || !body.access_token) {
      const err = new Error(`Zoom auth ${res.status}: ${body.reason || body.message || body.error || text}`);
      err.status = res.status;
      throw err;
    }
    this.accessToken = body.access_token;
    // Refresh 5 minutes early so a token never expires mid-sync.
    const lifetimeSec = Math.max(0, Number(body.expires_in || 3600) - 300);
    this.tokenExpiresAt = Date.now() + lifetimeSec * 1000;
    return this.accessToken;
  }

  /** GET against the Zoom API. `path` must already be URL-encoded. */
  async get(path, query = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
    }
    let refreshed = false;
    let rateTries = 1;
    let serverRetries = 0;
    for (;;) {
      const token = await this.token();
      let res;
      try {
        res = await this.fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
      } catch (e) {
        // Network blip: treat like a 5xx.
        if (serverRetries < 3) { await this.sleep(1000 * 2 ** serverRetries++); continue; }
        throw e;
      }
      if (res.ok) {
        const text = await res.text();
        return text ? parseJson(text) : {};
      }
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        this.accessToken = null;
        continue;
      }
      if (res.status === 429 && rateTries < 4) {
        const retryAfter = Number(res.headers?.get?.("retry-after"));
        await this.sleep(retryAfter > 0 ? retryAfter * 1000 : 2000 * 2 ** (rateTries - 1));
        rateTries++;
        continue;
      }
      if (res.status >= 500 && serverRetries < 3) {
        await this.sleep(1000 * 2 ** serverRetries++);
        continue;
      }
      const text = await res.text();
      const body = parseJson(text);
      const err = new Error(`Zoom ${res.status} ${path}: ${body.message || text}`);
      err.status = res.status;
      err.code = body.code;
      throw err;
    }
  }

  async paginate(path, query = {}, listKey) {
    const out = [];
    let nextPageToken = "";
    for (let page = 0; page < MAX_PAGES; page++) {
      const body = await this.get(path, { ...query, page_size: 300, next_page_token: nextPageToken || undefined });
      out.push(...(body[listKey] || []));
      nextPageToken = body.next_page_token || "";
      if (!nextPageToken) break;
    }
    return out;
  }

  // Zoom requires double-encoding for meeting UUIDs that start with "/" or contain "//".
  encodeUuid(uuid) {
    const s = String(uuid);
    return s.startsWith("/") || s.includes("//") ? encodeURIComponent(encodeURIComponent(s)) : encodeURIComponent(s);
  }

  getMeeting(meetingId) {
    return this.get(`/meetings/${encodeURIComponent(meetingId)}`);
  }

  async listPastInstances(meetingId) {
    const body = await this.get(`/past_meetings/${encodeURIComponent(meetingId)}/instances`);
    return body.meetings || [];
  }

  getMeetingReport(uuid) {
    return this.get(`/report/meetings/${this.encodeUuid(uuid)}`);
  }

  listReportParticipants(uuid) {
    return this.paginate(`/report/meetings/${this.encodeUuid(uuid)}/participants`, { include_fields: "registrant_id" }, "participants");
  }

  listRegistrants(meetingId) {
    return this.paginate(`/meetings/${encodeURIComponent(meetingId)}/registrants`, { status: "approved" }, "registrants");
  }

  listUsers() {
    return this.paginate("/users", {}, "users");
  }

  listUserMeetings(userId, type) {
    return this.paginate(`/users/${encodeURIComponent(userId)}/meetings`, { type }, "meetings");
  }

  /**
   * Find the meeting behind a registration link (they carry no meeting ID).
   * → { meetingId, topic, startTime, durationMin } | null
   */
  async resolveRegistrationUrl(url) {
    const token = String(url || "").match(/\/register\/([^/?#\s]+)/)?.[1];
    if (!token) return null;
    const matches = m => String(m.registration_url || "").includes(token);
    const shape = m => ({
      meetingId: String(m.id),
      topic: m.topic || null,
      startTime: m.start_time ? new Date(m.start_time).toISOString() : null,
      durationMin: m.duration ?? null
    });

    // Meeting lists don't always carry registration_url, so remember the ones
    // we could not check and look them up one by one if nothing matched.
    const unchecked = new Map();
    for (const user of await this.listUsers()) {
      for (const type of ["scheduled", "upcoming"]) {
        for (const m of await this.listUserMeetings(user.id, type)) {
          if (matches(m)) return shape(await this.getMeeting(m.id).catch(() => m));
          if (!("registration_url" in m)) unchecked.set(String(m.id), m);
        }
      }
    }
    for (const id of unchecked.keys()) {
      const full = await this.getMeeting(id).catch(() => null);
      if (full && matches(full)) return shape(full);
    }
    return null;
  }
}

function parseJson(text) {
  try {
    return JSON.parse(text) || {};
  } catch {
    return {};
  }
}
