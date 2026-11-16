import pg from "pg";
import { readdir, readFile } from "node:fs/promises";

export function createPool(env = process.env) {
    if (!env.DATABASE_URL && !env.PGHOST) {
        throw new Error("Set DATABASE_URL or PGHOST to configure PostgreSQL.");
    }
    const pool = new pg.Pool({
        ...(env.DATABASE_URL ? { connectionString: env.DATABASE_URL } : {}),
        max: 5,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: 15_000,
        application_name: "jobs-mcp"
    });
    pool.on("error", error => console.error("Idle database connection failed:", error.code));
    return pool;
}

export async function migrate(pool) {
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        // Serialize migrations even if two processes start together.
        await client.query("SELECT pg_advisory_xact_lock(68732619)");
        await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
            name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
        )`);
        const directory = new URL("./migrations/", import.meta.url);
        for (const name of (await readdir(directory)).filter(name => name.endsWith(".sql")).sort()) {
            const applied = await client.query("SELECT name FROM schema_migrations WHERE name = $1", [name]);
            if (applied.rows.length) continue;
            await client.query(await readFile(new URL(name, directory), "utf8"));
            await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [name]);
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally {
        client.release();
    }
}
