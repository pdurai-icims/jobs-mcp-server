import { randomUUID } from "node:crypto";
import { jobFields, storedJobSchema, updatesSchema } from "../job-schema.js";

// Do not expose Auth0 subject identifiers through public tool results.
const columns = ["id", "slug", "req_id", ...Object.keys(jobFields), "created_at", "updated_at", "version"].join(", ");

export class JobStoreError extends Error {}

function requireSubject(subject) {
    if (typeof subject !== "string" || !subject.trim()) throw new JobStoreError("Authentication required.");
}

export function createJobRepository(db) {
    return {
        async search({ query = "", location = "", limit = 5 } = {}) {
            if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new JobStoreError("Limit must be between 1 and 20.");
            // strpos treats %, _ and backslashes literally; all values are parameters.
            const result = await db.query(`SELECT ${columns}, count(*) OVER()::integer AS total_found
                FROM jobs WHERE searchable AND
                ($1 = '' OR strpos(lower(concat_ws(' ', title, description, array_to_string(skills, ' '))), lower($1)) > 0) AND
                ($2 = '' OR strpos(lower(concat_ws(' ', city, state, country, job_type)), lower($2)) > 0)
                ORDER BY created_at DESC, id LIMIT $3`, [query.trim(), location.trim(), limit]);
            return {
                count: result.rows.length,
                total_found: result.rows[0]?.total_found ?? 0,
                jobs: result.rows.map(({ total_found, ...job }) => job)
            };
        },

        async get(identifier) {
            const result = await db.query(`SELECT ${columns} FROM jobs
                WHERE id::text = $1 OR slug = $1 OR req_id = $1 OR legacy_id = $1
                ORDER BY CASE WHEN id::text = $1 THEN 0 WHEN slug = $1 THEN 1 WHEN req_id = $1 THEN 2 ELSE 3 END
                LIMIT 1`, [identifier]);
            return result.rows[0] ?? null;
        },

        async getBySlug(slug) {
            const result = await db.query(`SELECT ${columns} FROM jobs WHERE slug = $1`, [slug]);
            return result.rows[0] ?? null;
        },

        async create(input, subject, metadata = {}) {
            requireSubject(subject);
            const job = Object.fromEntries(Object.entries(storedJobSchema.parse(input)).filter(([, value]) => value !== undefined));
            const id = metadata.id ?? randomUUID();
            const titleSlug = job.title.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "job";
            const values = {
                id, slug: metadata.slug ?? `${titleSlug}-${id}`,
                req_id: metadata.req_id ?? null, legacy_id: metadata.legacy_id ?? null,
                ...job, created_by: subject, updated_by: subject
            };
            const keys = Object.keys(values);
            // Keys come exclusively from validated fields and server-defined metadata.
            const result = await db.query(`INSERT INTO jobs (${keys.join(", ")})
                VALUES (${keys.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING ${columns}`, Object.values(values));
            return result.rows[0];
        },

        async update(slug, input, subject, expectedVersion) {
            requireSubject(subject);
            if (!Number.isInteger(expectedVersion) || expectedVersion < 1) throw new JobStoreError("Prepare a fresh job update preview.");
            const updates = updatesSchema.parse(input);
            const entries = Object.entries(updates).filter(([, value]) => value !== undefined);
            const values = entries.map(([, value]) => value);
            values.push(subject, slug, expectedVersion);
            const n = entries.length;
            const result = await db.query(`UPDATE jobs SET
                ${entries.map(([key], i) => `${key} = $${i + 1}`).join(", ")},
                updated_by = $${n + 1}, updated_at = now(), version = version + 1
                WHERE slug = $${n + 2} AND version = $${n + 3} RETURNING ${columns}`, values);
            if (!result.rows[0]) throw new JobStoreError("Job changed or no longer exists. Fetch its details and prepare a fresh preview before retrying.");
            return result.rows[0];
        }
    };
}
