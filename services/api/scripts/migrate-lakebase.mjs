import { readdir, readFile } from "node:fs/promises";

import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.LAKEBASE_DATABASE_URL;
if (!databaseUrl || databaseUrl === "<PLACEHOLDER>") {
  throw new Error("LAKEBASE_DATABASE_URL is required");
}

const migrationsDirectory = new URL(
  "../../../databricks/lakebase/migrations/",
  import.meta.url,
);
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => name.endsWith(".sql"))
  .sort();
const pool = new Pool({
  connectionString: databaseUrl,
  ssl: process.env.LAKEBASE_SSL === "0"
    ? false
    : {
        rejectUnauthorized:
          process.env.LAKEBASE_SSL_REJECT_UNAUTHORIZED !== "0",
      },
});
try {
  for (const migrationFile of migrationFiles) {
    const migration = await readFile(
      new URL(migrationFile, migrationsDirectory),
      "utf8",
    );
    await pool.query(migration);
  }
  console.log(`Lakebase migrations: PASS (${migrationFiles.length})`);
} finally {
  await pool.end();
}
