// Vercel entry point: every /api/* request lands here (see vercel.json); the UI is static from public/.
import { createApp } from "../server/index.js";
import { initDb } from "../server/db.js";
import { ensureFirstAdmin } from "../server/auth.js";

const ready = initDb().then(ensureFirstAdmin);
const app = createApp();

export default async function handler(req, res) {
  await ready;
  return app(req, res);
}
