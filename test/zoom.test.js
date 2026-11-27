import { test } from "node:test";
import assert from "node:assert/strict";
import { ZoomClient, loadZoomAccounts, parseMeetingRef } from "../server/zoom.js";

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

/** Fake fetch: token endpoint handled automatically, API calls go to `handler(url)`. */
function fakeFetch(handler, { expiresIn = 3600 } = {}) {
  const calls = { token: 0, api: [] };
  const fn = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === "zoom.us" && u.pathname === "/oauth/token") {
      calls.token++;
      assert.equal(opts.method, "POST");
      assert.equal(opts.headers.Authorization, `Basic ${Buffer.from("cid:secret").toString("base64")}`);
      assert.equal(u.searchParams.get("account_id"), "acc");
      return json({ access_token: `tok${calls.token}`, expires_in: expiresIn });
    }
    calls.api.push({ url: u, auth: opts.headers.Authorization });
    return handler(u, calls);
  };
  return { fn, calls };
}

const client = (fetchImpl, sleeps = []) =>
  new ZoomClient({ accountId: "acc", clientId: "cid", clientSecret: "secret", fetchImpl, sleepImpl: async ms => { sleeps.push(ms); } });

test("loadZoomAccounts always lists account 1, others only when set", () => {
  const accts = loadZoomAccounts({
    ZOOM_1_LABEL: "Main", ZOOM_1_ACCOUNT_ID: "a", ZOOM_1_CLIENT_ID: "b", ZOOM_1_CLIENT_SECRET: "c",
    ZOOM_3_ACCOUNT_ID: "x"
  });
  assert.deepEqual(accts.map(a => [a.key, a.label, a.connected]), [
    ["zoom1", "Main", true],
    ["zoom3", "Zoom account 3", false]
  ]);
});

test("token is cached and reused", async () => {
  const { fn, calls } = fakeFetch(() => json({ ok: 1 }));
  const c = client(fn);
  await c.get("/users/me");
  await c.get("/users/me");
  assert.equal(calls.token, 1);
  assert.equal(calls.api[1].auth, "Bearer tok1");
});

test("token close to expiry is refreshed", async () => {
  const { fn, calls } = fakeFetch(() => json({ ok: 1 }), { expiresIn: 200 });
  const c = client(fn);
  await c.get("/users/me");
  await c.get("/users/me");
  assert.equal(calls.token, 2);
});

test("401 refreshes the token once and retries", async () => {
  const { fn, calls } = fakeFetch((u, calls) => (calls.api.length === 1 ? json({ message: "expired" }, 401) : json({ id: 1 })));
  const c = client(fn);
  assert.deepEqual(await c.get("/meetings/1"), { id: 1 });
  assert.equal(calls.token, 2);
  assert.equal(calls.api[1].auth, "Bearer tok2");
});

test("401 twice throws with status", async () => {
  const { fn } = fakeFetch(() => json({ message: "Invalid access token." }, 401));
  await assert.rejects(client(fn).get("/meetings/1"), err => err.status === 401 && err.message === "Zoom 401 /meetings/1: Invalid access token.");
});

test("429 waits Retry-After then retries", async () => {
  const sleeps = [];
  const { fn, calls } = fakeFetch((u, calls) => (calls.api.length === 1 ? json({}, 429, { "retry-after": "3" }) : json({ id: 2 })));
  assert.deepEqual(await client(fn, sleeps).get("/meetings/2"), { id: 2 });
  assert.deepEqual(sleeps, [3000]);
  assert.equal(calls.api.length, 2);
});

test("429 without Retry-After backs off 2s,4s,8s then gives up", async () => {
  const sleeps = [];
  const { fn, calls } = fakeFetch(() => json({ message: "Too many requests" }, 429));
  await assert.rejects(client(fn, sleeps).get("/x"), err => err.status === 429);
  assert.deepEqual(sleeps, [2000, 4000, 8000]);
  assert.equal(calls.api.length, 4);
});

test("5xx retries three times", async () => {
  const sleeps = [];
  const { fn, calls } = fakeFetch((u, calls) => (calls.api.length <= 3 ? json({}, 502) : json({ fine: true })));
  assert.deepEqual(await client(fn, sleeps).get("/x"), { fine: true });
  assert.equal(sleeps.length, 3);
  assert.equal(calls.api.length, 4);
});

test("other errors throw immediately", async () => {
  const { fn, calls } = fakeFetch(() => json({ code: 3001, message: "Meeting does not exist" }, 404));
  await assert.rejects(client(fn).get("/meetings/9"), err => err.status === 404 && /Meeting does not exist/.test(err.message));
  assert.equal(calls.api.length, 1);
});

test("paginate follows next_page_token with page_size=300", async () => {
  const { fn, calls } = fakeFetch(u => {
    const t = u.searchParams.get("next_page_token");
    if (!t) return json({ registrants: [{ id: "a" }, { id: "b" }], next_page_token: "p2" });
    if (t === "p2") return json({ registrants: [{ id: "c" }], next_page_token: "" });
    throw new Error("unexpected page");
  });
  const regs = await client(fn).listRegistrants("123");
  assert.deepEqual(regs.map(r => r.id), ["a", "b", "c"]);
  assert.equal(calls.api.length, 2);
  for (const { url } of calls.api) {
    assert.equal(url.pathname, "/v2/meetings/123/registrants");
    assert.equal(url.searchParams.get("page_size"), "300");
    assert.equal(url.searchParams.get("status"), "approved");
  }
});

test("encodeUuid double-encodes uuids starting with / or containing //", () => {
  const c = client(async () => json({}));
  assert.equal(c.encodeUuid("/ajXp112QmuoKj4854875=="), "%252FajXp112QmuoKj4854875%253D%253D");
  assert.equal(c.encodeUuid("ab//cd=="), "ab%252F%252Fcd%253D%253D");
  assert.equal(c.encodeUuid("4444AAAiAAAAAiAiAiiAii=="), "4444AAAiAAAAAiAiAiiAii%3D%3D");
});

test("report participants use the double-encoded uuid and include registrant_id", async () => {
  const { fn, calls } = fakeFetch(() => json({ participants: [{ id: "p1" }] }));
  await client(fn).listReportParticipants("/abc==");
  assert.ok(calls.api[0].url.href.startsWith("https://api.zoom.us/v2/report/meetings/%252Fabc%253D%253D/participants?"));
  assert.equal(calls.api[0].url.searchParams.get("include_fields"), "registrant_id");
});

test("resolveRegistrationUrl finds the meeting across users", async () => {
  const { fn } = fakeFetch(u => {
    if (u.pathname === "/v2/users") return json({ users: [{ id: "u1" }, { id: "u2" }] });
    if (u.pathname === "/v2/users/u1/meetings") return json({ meetings: [{ id: 111, registration_url: "https://zoom.us/meeting/register/other" }] });
    if (u.pathname === "/v2/users/u2/meetings") {
      return json({ meetings: [{ id: 222, topic: "Learning", registration_url: "https://us06web.zoom.us/meeting/register/Z6xE3U0_R9-DVaBsCKaM7g" }] });
    }
    if (u.pathname === "/v2/meetings/222") {
      return json({ id: 222, topic: "Flute Learning", start_time: "2026-11-01T04:30:00Z", duration: 90, registration_url: "https://us06web.zoom.us/meeting/register/Z6xE3U0_R9-DVaBsCKaM7g" });
    }
    return json({ message: "nope" }, 404);
  });
  const found = await client(fn).resolveRegistrationUrl("https://zoom.us/meeting/register/Z6xE3U0_R9-DVaBsCKaM7g");
  assert.deepEqual(found, { meetingId: "222", topic: "Flute Learning", startTime: "2026-11-01T04:30:00.000Z", durationMin: 90 });
});

test("resolveRegistrationUrl falls back to meeting details and returns null when absent", async () => {
  const { fn } = fakeFetch(u => {
    if (u.pathname === "/v2/users") return json({ users: [{ id: "u1" }] });
    if (u.pathname === "/v2/users/u1/meetings") return json({ meetings: [{ id: 333, topic: "Practice" }] });
    if (u.pathname === "/v2/meetings/333") return json({ id: 333, topic: "Practice", duration: 60, registration_url: "https://zoom.us/meeting/register/TOK123" });
    return json({}, 404);
  });
  const c = client(fn);
  assert.equal((await c.resolveRegistrationUrl("https://zoom.us/meeting/register/TOK123")).meetingId, "333");
  assert.equal(await c.resolveRegistrationUrl("https://zoom.us/meeting/register/MISSING"), null);
  assert.equal(await c.resolveRegistrationUrl("https://zoom.us/j/123"), null);
});

test("parseMeetingRef", () => {
  assert.deepEqual(parseMeetingRef("812 3456 7890"), { meetingId: "81234567890" });
  assert.deepEqual(parseMeetingRef("https://us06web.zoom.us/j/81234567890?pwd=abc"), { meetingId: "81234567890" });
  assert.deepEqual(parseMeetingRef("https://zoom.us/meeting/register/Z6xE3U0_R9-DVaBsCKaM7g"), { registrationUrl: "https://zoom.us/meeting/register/Z6xE3U0_R9-DVaBsCKaM7g" });
  assert.equal(parseMeetingRef("hello"), null);
  assert.equal(parseMeetingRef(""), null);
  assert.equal(parseMeetingRef("https://example.com/j/123"), null);
});
