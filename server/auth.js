// Email + password login with server-side sessions in Postgres.
import crypto from "node:crypto";
import { promisify } from "node:util";
import { q, q1 } from "./db.js";

const scrypt = promisify(crypto.scrypt);
const COOKIE = "fg_session";
const SESSION_DAYS = 14;

export const ROLE_ACCESS = {
  "Admin": ["overview", "sessions", "learners", "lists", "review", "sync", "settings"],
  "Team member": ["learners", "lists"],
  "Viewer": ["overview"]
};

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const key = await scrypt(String(password), Buffer.from(saltHex, "hex"), 64);
  const expected = Buffer.from(keyHex, "hex");
  return expected.length === key.length && crypto.timingSafeEqual(expected, key);
}

export function publicUser(u) {
  const initials = String(u.name || u.email).split(/\s+/).map(s => s[0]).join("").slice(0, 2).toUpperCase();
  return { id: u.id, name: u.name, email: u.email, role: u.role, initials };
}

/** Create the first Admin from ADMIN_EMAIL / ADMIN_PASSWORD when no users exist. */
export async function ensureFirstAdmin(env = process.env) {
  const { count } = await q1(`SELECT count(*)::int AS count FROM users`);
  if (count > 0) return null;
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    console.warn("No users yet. Set ADMIN_EMAIL and ADMIN_PASSWORD to create the first admin.");
    return null;
  }
  const u = await q1(
    `INSERT INTO users (email, name, role, password_hash) VALUES ($1, $2, 'Admin', $3) RETURNING *`,
    [env.ADMIN_EMAIL.trim().toLowerCase(), env.ADMIN_NAME || "Admin", await hashPassword(env.ADMIN_PASSWORD)]
  );
  console.log(`Created first admin ${u.email}`);
  return u;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(value, maxAgeSec) {
  const secure = process.env.COOKIE_SECURE === "true" ? "; Secure" : "";
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure}`;
}

export async function login(req, res) {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const u = email ? await q1(`SELECT * FROM users WHERE email = $1 AND active`, [email]) : null;
  if (!u || !(await verifyPassword(password, u.password_hash))) {
    return res.status(401).json({ error: "Wrong email or password" });
  }
  const token = crypto.randomBytes(32).toString("hex");
  await q(`INSERT INTO auth_sessions (token, user_id, expires_at) VALUES ($1, $2, now() + interval '${SESSION_DAYS} days')`, [token, u.id]);
  res.setHeader("Set-Cookie", cookieString(token, SESSION_DAYS * 86400));
  res.json({ user: publicUser(u) });
}

export async function logout(req, res) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) await q(`DELETE FROM auth_sessions WHERE token = $1`, [token]);
  res.setHeader("Set-Cookie", cookieString("", 0));
  res.json({ ok: true });
}

/** Attaches req.user when the cookie is valid. Never rejects on its own. */
export async function loadUser(req, _res, next) {
  try {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (token) {
      const u = await q1(
        `SELECT u.* FROM auth_sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token = $1 AND s.expires_at > now() AND u.active`,
        [token]
      );
      if (u) req.user = u;
    }
    next();
  } catch (e) {
    next(e);
  }
}

/** Gate a route: requireRole("Admin", "Viewer"). No args = any signed-in user. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: "Please sign in" });
    if (roles.length && !roles.includes(req.user.role)) return res.status(403).json({ error: "Your role can't see this" });
    next();
  };
}
