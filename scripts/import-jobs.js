import { readFile } from "node:fs/promises";
import { createPool, migrate } from "../db/index.js";
import { normalizeExport, importJobs } from "./import-data.js";

const filename = process.argv[2];
if (!filename) throw new Error("Usage: npm run db:import -- path/to/jobs.json");
const records = normalizeExport(JSON.parse(await readFile(filename, "utf8")));
const pool = createPool();
try {
    await migrate(pool);
    console.log(await importJobs(pool, records, filename === "data/demo-jobs.json" ? "demo:seed" : "demo:import"));
} catch (error) {
    console.error("Import failed; transaction rolled back:", error.code ?? error.name);
    process.exitCode = 1;
} finally { await pool.end(); }
