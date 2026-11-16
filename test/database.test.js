import assert from "node:assert/strict";
import { before, after, beforeEach, test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testDatabase } from "./helpers/database.js";
import { createJobRepository } from "../db/jobs.js";
import { migrate } from "../db/index.js";
import { normalizeExport, importJobs } from "../scripts/import-data.js";

let database, jobs;
const input = { title: "Developer", description: "Build applications", experience: "3 years", skills: ["React", "SQL"], city: "Chennai" };
before(async () => { database = await testDatabase(); jobs = createJobRepository(database.pool); });
after(async () => { await database?.close(); });
beforeEach(async () => { await database.pool.query("DELETE FROM jobs"); });

test("migrations are repeatable and tracked once", async () => {
    await migrate(database.pool);
    assert.equal((await database.pool.query("SELECT * FROM schema_migrations")).rows.length, 1);
});

test("create, search and direct lookup preserve data and keep actor IDs private", async () => {
    const created = await jobs.create(input, "auth0:alice", { req_id: "REQ-1", legacy_id: "42" });
    assert.match(created.id, /^[a-f0-9-]{36}$/);
    assert.deepEqual(created.skills, ["React", "SQL"]);
    assert.equal(created.version, 1);
    assert.equal(created.created_by, undefined);
    for (const key of [created.id, created.slug, "REQ-1", "42"]) assert.equal((await jobs.get(key)).id, created.id);
    const found = await jobs.search({ query: "sql", location: "CHENNAI" });
    assert.equal(found.count, 1);
    assert.equal((await jobs.get("missing")), null);
    const row = (await database.pool.query("SELECT created_by, updated_by FROM jobs")).rows[0];
    assert.deepEqual(row, { created_by: "auth0:alice", updated_by: "auth0:alice" });
});

test("filtering and total counts happen before limiting; details are not paginated", async () => {
    for (let i = 0; i < 25; i++) await jobs.create({ ...input, title: `Engineer ${i}` }, "user");
    const target = await jobs.create({ ...input, title: "Special match" }, "user");
    const found = await jobs.search({ query: "Engineer", limit: 2 });
    assert.equal(found.count, 2);
    assert.equal(found.total_found, 25);
    assert.equal((await jobs.get(target.id)).title, "Special match");
    assert.equal((await jobs.search({ query: "Special", limit: 1 })).jobs[0].id, target.id);
});

test("SQL injection and LIKE wildcards are literal data", async () => {
    const created = await jobs.create({ ...input, title: "100% SQL _expert", description: "Robert'); DROP TABLE jobs;--" }, "user");
    assert.equal((await jobs.search({ query: "%" })).count, 1);
    assert.equal((await jobs.search({ query: "' OR 1=1 --" })).count, 0);
    assert.equal((await jobs.search({ query: "DROP TABLE" })).count, 1);
    assert.equal((await jobs.get(created.id)).id, created.id);
    await assert.rejects(jobs.update(created.slug, { "title = null; DROP TABLE jobs; --": "x" }, "user", 1));
});

test("any authenticated user can edit; partial updates preserve other fields", async () => {
    const created = await jobs.create(input, "alice");
    const updated = await jobs.update(created.slug, { city: null, skills: [], salary_value: 0, searchable: false }, "bob", 1);
    assert.equal(updated.title, input.title);
    assert.equal(updated.city, null);
    assert.deepEqual(updated.skills, []);
    assert.equal(updated.salary_value, 0);
    assert.equal(updated.version, 2);
    assert.equal((await jobs.search()).count, 0);
    assert.equal((await jobs.get(created.id)).id, created.id);
    const row = (await database.pool.query("SELECT created_by, updated_by FROM jobs")).rows[0];
    assert.deepEqual(row, { created_by: "alice", updated_by: "bob" });
});

test("concurrent edits only allow one update against a version", async () => {
    const created = await jobs.create(input, "alice");
    const results = await Promise.allSettled([
        jobs.update(created.slug, { title: "First edit" }, "bob", 1),
        jobs.update(created.slug, { title: "Second edit" }, "charlie", 1)
    ]);
    assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
    assert.match(results.find(result => result.status === "rejected").reason.message, /changed/);
    assert.equal((await jobs.get(created.id)).version, 2);
});

test("storage boundary rejects invalid fields and missing actors", async () => {
    for (const invalid of [{ title: " " }, { salary_value: -1 }, { salary_value: Infinity }, { salary_currency: "XYZ" }, { skills: "React" }, { extra: 1 }]) {
        await assert.rejects(jobs.create({ ...input, ...invalid }, "user"));
    }
    await assert.rejects(jobs.create(input, ""));
    const created = await jobs.create(input, "user");
    for (const invalid of [{}, { description: null }, { salary_value: -1 }, { skills: [" "] }, { salary_currency: "XYZ" }]) {
        await assert.rejects(jobs.update(created.slug, invalid, "user", 1));
    }
});

test("legacy import preserves identifiers, normalizes skills and never overwrites edits", async () => {
    const records = normalizeExport({ jobs: [{ ...input, id: 42, slug: "legacy", req_id: "REQ-42", skills: "React, SQL", source_extra: "ignored" }] });
    assert.deepEqual(await importJobs(database.pool, records), { inserted: 1, skipped: 0 });
    const job = await jobs.get("42");
    assert.equal(job.slug, "legacy");
    assert.deepEqual(job.skills, ["React", "SQL"]);
    await jobs.update(job.slug, { title: "Edited by a participant" }, "user", 1);
    assert.deepEqual(await importJobs(database.pool, records), { inserted: 0, skipped: 1 });
    assert.equal((await jobs.get("REQ-42")).title, "Edited by a participant");
});

test("seed can be run repeatedly without duplicating jobs", async () => {
    const records = normalizeExport(JSON.parse(await readFile(new URL("../data/demo-jobs.json", import.meta.url), "utf8")));
    assert.deepEqual(await importJobs(database.pool, records), { inserted: 3, skipped: 0 });
    assert.deepEqual(await importJobs(database.pool, records), { inserted: 0, skipped: 3 });
});

test("bad exports are rejected before import and transaction failures roll back", async () => {
    assert.throws(() => normalizeExport([{ ...input, id: 1 }, { id: 2 }]), /index 1/);
    assert.throws(() => normalizeExport([input]), /index 0/);
    const records = normalizeExport([{ ...input, id: 1 }, { ...input, id: 2 }]);
    records[1].job.salary_value = -1;
    await assert.rejects(importJobs(database.pool, records));
    assert.equal((await jobs.search()).count, 0);
});

test("jobs persist after closing and reopening a database on disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "jobs-mcp-test-"));
    let disk;
    try {
        disk = await testDatabase(directory);
        const created = await createJobRepository(disk.pool).create(input, "alice");
        await disk.close();
        disk = await testDatabase(directory);
        assert.equal((await createJobRepository(disk.pool).get(created.id)).title, input.title);
    } finally {
        await disk?.close();
        await rm(directory, { recursive: true, force: true });
    }
});
