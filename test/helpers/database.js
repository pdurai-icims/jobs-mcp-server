import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import { randomUUID } from "node:crypto";
import { migrate } from "../../db/index.js";

export async function testDatabase(dataDir) {
    // Optional real PostgreSQL run: isolates all test data in a temporary schema.
    if (process.env.TEST_DATABASE_URL && !dataDir) {
        const schema = `test_${randomUUID().replaceAll("-", "")}`;
        const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
        await admin.query(`CREATE SCHEMA ${schema}`);
        const pool = new pg.Pool({
            connectionString: process.env.TEST_DATABASE_URL,
            options: `-c search_path=${schema},public`
        });
        await migrate(pool);
        return {
            pool,
            close: async () => {
                await pool.end();
                await admin.query(`DROP SCHEMA ${schema} CASCADE`);
                await admin.end();
            }
        };
    }
    const database = await PGlite.create(dataDir);
    const query = async (sql, values) => values === undefined ?
        (await database.exec(sql)).at(-1) : database.query(sql, values);
    const pool = {
        query,
        connect: async () => ({ query, release() {} })
    };
    await migrate(pool);
    return { pool, close: () => database.close() };
}
