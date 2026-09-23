/**
 * TELES ADS — Migration runner (planworkv1 Phase 2, #34)
 *
 * Usage: node migrate.cjs
 * Applies pending files from ./migrations in filename order inside the
 * tracked schema_migrations table. Files MUST be idempotent (IF NOT EXISTS).
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set.");
    process.exit(1);
  }
  const pool = new Pool({ connectionString: url, max: 2, ssl: { rejectUnauthorized: false } });
  const client = await pool.connect();
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())"
    );
    const applied = new Set((await client.query("SELECT version FROM schema_migrations")).rows.map((r) => r.version));
    const dir = path.join(__dirname, "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    let ran = 0;
    for (const f of files) {
      if (applied.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), "utf8");
      console.log("applying", f, "...");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [f]);
        await client.query("COMMIT");
        ran++;
      } catch (e) {
        await client.query("ROLLBACK");
        console.error("FAILED", f, e.message);
        throw e;
      }
    }
    const total = (await client.query("SELECT count(*)::int n FROM schema_migrations")).rows[0].n;
    console.log(`migrations: applied ${ran}, total tracked ${total}`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => {
  console.error("migrate failed:", e.message);
  process.exit(1);
});
