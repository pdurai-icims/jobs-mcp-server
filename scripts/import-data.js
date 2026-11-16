import { createHash } from "node:crypto";
import { z } from "zod";
import { jobFields, storedJobSchema } from "../job-schema.js";
import { createJobRepository } from "../db/jobs.js";

const identifier = z.union([z.string().trim().min(1), z.number().finite()]).transform(String);
const metadataSchema = z.object({
    id: identifier.optional(),
    slug: z.string().trim().min(1).refine(value => value !== "." && value !== "..").optional(),
    req_id: identifier.nullable().optional()
});

export function normalizeExport(value) {
    const records = Array.isArray(value) ? value : value?.jobs;
    if (!Array.isArray(records)) throw new Error("Expected a JSON array or an object with a jobs array.");
    return records.map((record, index) => {
        try {
            const metadata = metadataSchema.parse(record);
            const fields = Object.fromEntries(Object.keys(jobFields).filter(key => record[key] !== undefined).map(key => [key, record[key]]));
            if (typeof fields.skills === "string") fields.skills = fields.skills.split(",").map(value => value.trim()).filter(Boolean);
            if (!fields.experience) fields.experience = "Not specified";
            const job = storedJobSchema.parse(fields);
            if (!metadata.id && !metadata.slug && !metadata.req_id) throw new Error("Each record needs an id, slug or req_id for repeatable imports.");
            // Stable UUID avoids duplicates on repeat imports even without a source slug.
            const identity = metadata.id ? `id:${metadata.id}` : metadata.slug ? `slug:${metadata.slug}` : `req:${metadata.req_id}`;
            const hash = createHash("sha256").update(`jobs-import:${identity}`).digest("hex");
            const id = z.string().uuid().safeParse(metadata.id).success ? metadata.id :
                `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
            return { job, metadata: { id, slug: metadata.slug, req_id: metadata.req_id, legacy_id: metadata.id } };
        } catch {
            throw new Error(`Invalid job at index ${index}. Check identifiers, title, description, skills, salary and currency. No records imported.`);
        }
    });
}

export async function importJobs(pool, records, subject = "demo:import") {
    const client = await pool.connect();
    let inserted = 0;
    let skipped = 0;
    try {
        await client.query("BEGIN");
        await client.query("SELECT pg_advisory_xact_lock(68732620)");
        const jobs = createJobRepository(client);
        for (const record of records) {
            const { id, slug, req_id, legacy_id } = record.metadata;
            const existing = await client.query(`SELECT id FROM jobs
                WHERE id = $1 OR slug = $2 OR req_id = $3 OR legacy_id = $4`, [id, slug ?? null, req_id ?? null, legacy_id ?? null]);
            if (existing.rows.length) { skipped++; continue; }
            await jobs.create(record.job, subject, record.metadata);
            inserted++;
        }
        await client.query("COMMIT");
        return { inserted, skipped };
    } catch (error) {
        await client.query("ROLLBACK");
        throw error;
    } finally { client.release(); }
}
