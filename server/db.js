// Postgres access. DATABASE_URL set → real Postgres (Supabase, Neon, self-hosted).
// Not set → embedded PGlite in ./data/pg so the app runs locally with zero setup.
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let driver = null;

export async function initDb({ url = process.env.DATABASE_URL, dataDir = process.env.PGLITE_DIR } = {}) {
  if (url) {
    if (!/^postgres(ql)?:\/\//.test(url)) {
      throw new Error("DATABASE_URL must be a postgresql:// connection string (Supabase: Connect → Session pooler), not the project https:// URL");
    }
    const { default: pg } = await import("pg");
    pg.types.setTypeParser(1082, v => v); // DATE stays "YYYY-MM-DD"
    pg.types.setTypeParser(20, v => Number(v)); // BIGINT counts as numbers
    const pool = new pg.Pool({ connectionString: url, max: 5, ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false } });
    driver = {
      kind: "postgres",
      query: (text, params) => pool.query(text, params),
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const out = await fn({ query: (t, p) => client.query(t, p) });
          await client.query("COMMIT");
          return out;
        } catch (e) {
          await client.query("ROLLBACK");
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end()
    };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const dir = dataDir === ":memory:" ? undefined : (dataDir || path.join(ROOT, "data", "pg"));
    const opts = { parsers: { 1082: v => v, 20: v => Number(v) } };
    // new PGlite(undefined, opts) silently ignores opts, so pass them alone for in-memory.
    const db = dir ? new PGlite(dir, opts) : new PGlite(opts);
    await db.waitReady;
    driver = {
      kind: "pglite",
      query: (text, params) => db.query(text, params),
      tx: fn => db.transaction(t => fn({ query: (q, p) => t.query(q, p) })),
      close: () => db.close()
    };
  }
  await migrate();
  return driver;
}

export function db() {
  if (!driver) throw new Error("Database not initialised");
  return driver;
}

export const q = (text, params) => db().query(text, params).then(r => r.rows);
export const q1 = (text, params) => q(text, params).then(rows => rows[0] || null);

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value JSONB NOT NULL
   );
   CREATE TABLE IF NOT EXISTS users (
     id SERIAL PRIMARY KEY,
     email TEXT NOT NULL UNIQUE,
     name TEXT NOT NULL,
     role TEXT NOT NULL CHECK (role IN ('Admin','Team member','Viewer')),
     password_hash TEXT NOT NULL,
     active BOOLEAN NOT NULL DEFAULT TRUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS auth_sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at TIMESTAMPTZ NOT NULL
   );
   CREATE TABLE IF NOT EXISTS batches (
     id SERIAL PRIMARY KEY,
     name TEXT,
     start_date DATE NOT NULL UNIQUE,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   -- One row per Zoom meeting used by a batch. A slot can hold several meetings
   -- (Harsh: links now change), and Tue + Thu share the practice meeting.
   CREATE TABLE IF NOT EXISTS batch_meetings (
     id SERIAL PRIMARY KEY,
     batch_id INTEGER NOT NULL REFERENCES batches(id) ON DELETE CASCADE,
     slot TEXT NOT NULL CHECK (slot IN ('learning_p1','learning_p2','practice_p1','practice_p2')),
     zoom_account TEXT NOT NULL,
     meeting_id TEXT,
     registration_url TEXT,
     topic TEXT,
     start_time TEXT,
     duration_min INTEGER,
     resolve_error TEXT,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS zoom_instances (
     uuid TEXT PRIMARY KEY,
     batch_meeting_id INTEGER NOT NULL REFERENCES batch_meetings(id) ON DELETE CASCADE,
     meeting_id TEXT NOT NULL,
     zoom_account TEXT NOT NULL,
     start_time TIMESTAMPTZ NOT NULL,
     end_time TIMESTAMPTZ,
     participants_count INTEGER,
     report_synced_at TIMESTAMPTZ,
     report_error TEXT
   );
   CREATE TABLE IF NOT EXISTS zoom_participants (
     id BIGSERIAL PRIMARY KEY,
     instance_uuid TEXT NOT NULL REFERENCES zoom_instances(uuid) ON DELETE CASCADE,
     participant_id TEXT,
     name TEXT,
     email TEXT,
     registrant_id TEXT,
     join_time TIMESTAMPTZ,
     leave_time TIMESTAMPTZ,
     duration_sec INTEGER
   );
   CREATE INDEX IF NOT EXISTS zoom_participants_instance ON zoom_participants(instance_uuid);
   CREATE TABLE IF NOT EXISTS zoom_registrants (
     meeting_id TEXT NOT NULL,
     registrant_id TEXT NOT NULL,
     email TEXT,
     first_name TEXT,
     last_name TEXT,
     phone TEXT,
     status TEXT,
     create_time TIMESTAMPTZ,
     PRIMARY KEY (meeting_id, registrant_id)
   );
   CREATE TABLE IF NOT EXISTS learners (
     id SERIAL PRIMARY KEY,
     source_key TEXT NOT NULL UNIQUE,
     name TEXT,
     email TEXT,
     phone TEXT,
     country TEXT,
     payment_date DATE,
     platform TEXT,
     product TEXT,
     status TEXT NOT NULL DEFAULT 'paid' CHECK (status IN ('paid','refunded')),
     raw JSONB,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE INDEX IF NOT EXISTS learners_email ON learners(lower(email));
   CREATE TABLE IF NOT EXISTS tagmango_events (
     id BIGSERIAL PRIMARY KEY,
     event TEXT,
     payload JSONB NOT NULL,
     received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     learner_id INTEGER,
     error TEXT
   );
   -- Decisions made in the review queue; remembered for every future sync.
   CREATE TABLE IF NOT EXISTS identity_links (
     identity_key TEXT PRIMARY KEY,
     decision TEXT NOT NULL CHECK (decision IN ('match','not_learner','skip')),
     learner_id INTEGER REFERENCES learners(id) ON DELETE CASCADE,
     decided_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
     decided_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS dnc (
     key TEXT PRIMARY KEY,
     note TEXT,
     added_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE IF NOT EXISTS sync_runs (
     id BIGSERIAL PRIMARY KEY,
     source TEXT NOT NULL,
     started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
     finished_at TIMESTAMPTZ,
     status TEXT NOT NULL DEFAULT 'running',
     records INTEGER NOT NULL DEFAULT 0,
     note TEXT,
     error TEXT
   );`,
  // Supabase serves the public schema over its REST API with the publishable key. RLS with no
  // policies blocks that path completely; this server connects as the table owner, which bypasses RLS.
  `ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
   ALTER TABLE users ENABLE ROW LEVEL SECURITY;
   ALTER TABLE auth_sessions ENABLE ROW LEVEL SECURITY;
   ALTER TABLE batches ENABLE ROW LEVEL SECURITY;
   ALTER TABLE batch_meetings ENABLE ROW LEVEL SECURITY;
   ALTER TABLE zoom_instances ENABLE ROW LEVEL SECURITY;
   ALTER TABLE zoom_participants ENABLE ROW LEVEL SECURITY;
   ALTER TABLE zoom_registrants ENABLE ROW LEVEL SECURITY;
   ALTER TABLE learners ENABLE ROW LEVEL SECURITY;
   ALTER TABLE tagmango_events ENABLE ROW LEVEL SECURITY;
   ALTER TABLE identity_links ENABLE ROW LEVEL SECURITY;
   ALTER TABLE dnc ENABLE ROW LEVEL SECURITY;
   ALTER TABLE sync_runs ENABLE ROW LEVEL SECURITY;
   ALTER TABLE schema_version ENABLE ROW LEVEL SECURITY;`,
  // Which Zoom user hosts the link (connect@ or hd@), so the UI can say where a session ran
  `ALTER TABLE batch_meetings ADD COLUMN IF NOT EXISTS host_email TEXT`
];

async function migrate() {
  await driver.query(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`);
  const rows = (await driver.query(`SELECT version FROM schema_version`)).rows;
  let version = rows.length ? rows[0].version : 0;
  if (!rows.length) await driver.query(`INSERT INTO schema_version (version) VALUES (0)`);
  for (; version < MIGRATIONS.length; version++) {
    for (const stmt of MIGRATIONS[version].split(/;\s*\n/).map(s => s.trim()).filter(Boolean)) {
      await driver.query(stmt);
    }
    await driver.query(`UPDATE schema_version SET version = $1`, [version + 1]);
  }
}

/** Insert many rows in chunks: insertMany("t", ["a","b"], [[1,2],[3,4]]). */
export async function insertMany(conn, table, columns, rows, chunk = 400) {
  for (let i = 0; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk);
    const params = [];
    const values = part.map(r => `(${r.map(v => { params.push(v); return `$${params.length}`; }).join(",")})`);
    await conn.query(`INSERT INTO ${table} (${columns.join(",")}) VALUES ${values.join(",")}`, params);
  }
}
