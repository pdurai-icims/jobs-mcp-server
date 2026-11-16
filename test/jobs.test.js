import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createApp } from "../server.js";
import { readConfig } from "../config.js";
import { createJobRepository } from "../db/jobs.js";
import { testDatabase } from "./helpers/database.js";

let database, jobs, listener, endpoint, close;
const newJob = { title: "Developer", description: "Build applications", experience: "3 years", skills: ["React"] };
const config = readConfig({
    PUBLIC_BASE_URL: "https://demo.example.com",
    AUTH0_ISSUER: "https://auth.example.com/",
    AUTH0_AUDIENCE: "jobs-demo",
    AUTH0_CLIENT_ID: "demo-client",
    AUTH0_CLIENT_SECRET: "test-only-secret"
});
before(async () => {
    database = await testDatabase();
    jobs = createJobRepository(database.pool);
    const service = createApp({ jobs, config, authenticate: async req => {
        const subject = req.headers["x-test-user"];
        return subject ? { sub: subject } : null;
    } });
    close = service.close;
    await new Promise((resolve, reject) => { listener = service.app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()); });
    endpoint = new URL(`http://127.0.0.1:${listener.address().port}/mcp`);
});
after(async () => {
    await close?.();
    if (listener) await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
    await database?.close();
});
beforeEach(async () => { await database.pool.query("DELETE FROM jobs"); });

async function connect(t, subject = "alice", dialog) {
    const client = new Client({ name: "jobs-test", version: "1.0.0" }, { capabilities: dialog ? { elicitation: { form: {} } } : {} });
    if (dialog) client.setRequestHandler(ElicitRequestSchema, dialog);
    const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { "x-test-user": subject } } });
    await client.connect(transport);
    t.after(async () => { await transport.terminateSession().catch(() => {}); await client.close(); });
    return { client, transport };
}
const call = (client, name, args) => client.callTool({ name, arguments: args });
const parse = response => JSON.parse(response.content[0].text);
const create = (client, job = newJob) => call(client, "create_job", job);
const confirmCreate = (client, id, confirm = true) => call(client, "confirm_job_creation", { confirmation_id: id, confirm });
const update = (client, slug, updates = { title: "Senior Developer" }) => call(client, "update_job", { slug, updates });
const confirmUpdate = (client, id, confirm = true) => call(client, "confirm_job_update", { confirmation_id: id, confirm });

// Creation intentionally uses the same two-tool chat flow for all clients.
test("creation previews all supplied fields and only saves after separate approval", async t => {
    const { client } = await connect(t, "alice", () => assert.fail("Creation must use the chat preview"));
    const input = { ...newJob, city: "Chennai", state: "Tamil Nadu", country: "India", employment_type: "Full-time", job_type: "Hybrid", industry: "Software", education_level: "Degree", salary_value: 0, salary_currency: "inr" };
    const preview = parse(await create(client, input));
    assert.deepEqual(preview.job, { ...input, salary_currency: "INR" });
    assert.equal(preview.status, "confirmation_required");
    assert.equal((await jobs.search()).count, 0);
    const created = parse(await confirmCreate(client, preview.confirmation_id));
    assert.equal(created.success, true);
    assert.equal((await jobs.get(created.job_id)).title, input.title);
    assert.equal((await confirmCreate(client, preview.confirmation_id)).isError, true);
    const row = (await database.pool.query("SELECT created_by FROM jobs")).rows[0];
    assert.equal(row.created_by, "alice");
});

test("creation previews are replaceable, session-bound, immutable and cancellable", async t => {
    const { client } = await connect(t);
    const other = await connect(t, "bob");
    const old = parse(await create(client));
    const preview = parse(await create(client, { ...newJob, title: "New title" }));
    assert.equal((await confirmCreate(client, old.confirmation_id)).isError, true);
    assert.equal((await confirmCreate(other.client, preview.confirmation_id)).isError, true);
    for (const args of [
        { confirmation_id: preview.confirmation_id },
        { confirmation_id: preview.confirmation_id, confirm: "true" },
        { confirmation_id: preview.confirmation_id, confirm: true, job: newJob }
    ]) assert.equal((await call(client, "confirm_job_creation", args)).isError, true);
    assert.match((await confirmCreate(client, preview.confirmation_id, false)).content[0].text, /cancelled/);
    assert.equal((await confirmCreate(client, preview.confirmation_id)).isError, true);
    assert.equal((await jobs.search()).count, 0);
});

test("creation requests a generated description and rejects invalid values", async t => {
    const { client } = await connect(t);
    const result = await create(client, { title: "Developer", experience: "3 years" });
    assert.equal(result.isError, true);
    assert.equal(parse(result).status, "description_required");
    for (const input of [{ title: " " }, { experience: "" }, { skills: "React" }, { city: " " }, { salary_value: -1 }, { salary_currency: "XYZ" }, { unknown: true }]) {
        assert.equal((await create(client, { ...newJob, ...input })).isError, true);
    }
    assert.equal((await jobs.search()).count, 0);
});

test("creation defaults appear in the preview and explicit values override them", async t => {
    for (const [key, value] of Object.entries({ DEFAULT_EMPLOYMENT_TYPE: "Full-time", DEFAULT_JOB_TYPE: "On-site", DEFAULT_SALARY_CURRENCY: "usd" })) {
        const previous = process.env[key];
        process.env[key] = value;
        t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
    }
    const { client } = await connect(t);
    const preview = parse(await create(client));
    assert.equal(preview.job.salary_currency, "USD");
    assert.equal(preview.job.employment_type, "Full-time");
    const explicit = parse(await create(client, { ...newJob, salary_currency: "inr", job_type: "Remote" }));
    assert.equal(explicit.job.salary_currency, "INR");
    assert.equal(explicit.job.job_type, "Remote");
});

test("two users share search results and may edit each other's jobs", async t => {
    const first = await connect(t, "alice");
    const second = await connect(t, "bob");
    const preview = parse(await create(first.client));
    const created = parse(await confirmCreate(first.client, preview.confirmation_id));
    const found = parse(await call(second.client, "search_jobs", { query: "react" }));
    assert.equal(found.jobs[0].id, created.job_id);
    const edit = parse(await update(second.client, created.job.slug, { city: "Bengaluru" }));
    assert.equal((await jobs.get(created.job_id)).city, null);
    assert.equal((await confirmUpdate(second.client, edit.confirmation_id)).isError, false);
    assert.equal(parse(await call(first.client, "get_job_details", { job_id: created.job_id })).city, "Bengaluru");
    assert.equal((await database.pool.query("SELECT updated_by FROM jobs")).rows[0].updated_by, "bob");
});

test("update native dialog displays exact changes and waits for explicit acceptance", { timeout: 15000 }, async t => {
    const job = await jobs.create(newJob, "alice");
    let finish;
    let shown;
    const dialogShown = new Promise(resolve => { shown = resolve; });
    const changes = { title: "Senior Developer", city: null, skills: [], salary_value: 0 };
    const { client } = await connect(t, "bob", request => {
        assert.deepEqual(JSON.parse(request.params.message.split("\n").slice(1).join("\n")), changes);
        assert.equal(request.params.requestedSchema.properties.confirm.default, false);
        shown();
        return new Promise(resolve => { finish = resolve; });
    });
    const pending = update(client, job.slug, changes);
    await dialogShown;
    assert.equal((await jobs.get(job.id)).version, 1);
    finish({ action: "accept", content: { confirm: true } });
    assert.equal((await pending).isError, false);
    assert.equal((await jobs.get(job.id)).title, "Senior Developer");
});

for (const answer of [{ action: "decline" }, { action: "cancel" }, { action: "accept", content: { confirm: false } }, { action: "accept", content: {} }, { action: "accept", content: { confirm: "true" } }]) {
    test(`native update does not write for ${JSON.stringify(answer)}`, async t => {
        const job = await jobs.create(newJob, "alice");
        const { client } = await connect(t, "bob", () => answer);
        await update(client, job.slug);
        assert.equal((await jobs.get(job.id)).version, 1);
    });
}

test("chat update confirmations are replaceable, isolated and single use", async t => {
    const job = await jobs.create(newJob, "alice");
    const { client } = await connect(t);
    const other = await connect(t); // Even another session for the same user cannot confirm.
    const old = parse(await update(client, job.slug, { title: "Old" }));
    const current = parse(await update(client, job.slug, { title: "New" }));
    assert.equal((await confirmUpdate(client, old.confirmation_id)).isError, true);
    assert.equal((await confirmUpdate(other.client, current.confirmation_id)).isError, true);
    assert.equal((await call(client, "confirm_job_update", { confirmation_id: current.confirmation_id, confirm: true, updates: { title: "Injected" } })).isError, true);
    assert.equal((await confirmUpdate(client, current.confirmation_id)).isError, false);
    assert.equal((await confirmUpdate(client, current.confirmation_id)).isError, true);
    assert.equal((await jobs.get(job.id)).title, "New");
    const cancelled = parse(await update(client, job.slug));
    await confirmUpdate(client, cancelled.confirmation_id, false);
    assert.equal((await confirmUpdate(client, cancelled.confirmation_id)).isError, true);
});

test("concurrent previews cannot overwrite a newer change", async t => {
    const job = await jobs.create(newJob, "alice");
    const first = await connect(t, "alice");
    const second = await connect(t, "bob");
    const a = parse(await update(first.client, job.slug, { title: "Alice edit" }));
    const b = parse(await update(second.client, job.slug, { title: "Bob edit" }));
    assert.equal((await confirmUpdate(second.client, b.confirmation_id)).isError, false);
    const stale = await confirmUpdate(first.client, a.confirmation_id);
    assert.equal(stale.isError, true);
    assert.match(stale.content[0].text, /changed/);
    assert.equal((await jobs.get(job.id)).title, "Bob edit");
});

test("duplicate simultaneous confirmations produce only one database write", async t => {
    const { client } = await connect(t);
    const preview = parse(await create(client));
    const results = await Promise.all([confirmCreate(client, preview.confirmation_id), confirmCreate(client, preview.confirmation_id)]);
    assert.equal(results.filter(result => !result.isError).length, 1);
    assert.equal((await jobs.search()).count, 1);
    const job = (await jobs.search()).jobs[0];
    const edit = parse(await update(client, job.slug));
    const updated = await Promise.all([confirmUpdate(client, edit.confirmation_id), confirmUpdate(client, edit.confirmation_id)]);
    assert.equal(updated.filter(result => !result.isError).length, 1);
    assert.equal((await jobs.get(job.id)).version, 2);
});

test("database failure consumes confirmation and never exposes database secrets", async t => {
    const { client } = await connect(t);
    const preview = parse(await create(client));
    const stub = t.mock.method(jobs, "create", async () => { throw new Error("postgres://secret:password@host/db"); });
    const result = await confirmCreate(client, preview.confirmation_id);
    assert.equal(result.isError, true);
    assert.doesNotMatch(result.content[0].text, /secret|password/);
    stub.mock.restore();
    assert.equal((await confirmCreate(client, preview.confirmation_id)).isError, true);
    assert.equal((await jobs.search()).count, 0);
});

test("creation and update confirmations expire after ten minutes", async t => {
    const job = await jobs.create(newJob, "alice");
    const { client } = await connect(t);
    const creation = parse(await create(client));
    const edit = parse(await update(client, job.slug));
    const future = Date.now() + 600001;
    t.mock.method(Date, "now", () => future);
    assert.equal((await confirmCreate(client, creation.confirmation_id)).isError, true);
    assert.equal((await confirmUpdate(client, edit.confirmation_id)).isError, true);
    assert.equal((await jobs.get(job.id)).version, 1);
});

test("invalid and nonexistent updates never become applicable previews", async t => {
    const job = await jobs.create(newJob, "alice");
    const { client } = await connect(t);
    for (const changes of [{}, { title: " " }, { description: null }, { unknown: true }, { skills: "Java" }, { salary_value: -1 }, { searchable: "true" }]) {
        assert.equal((await update(client, job.slug, changes)).isError, true);
    }
    assert.equal((await update(client, "missing")).isError, true);
    assert.equal((await jobs.get(job.id)).version, 1);
});

test("every MCP request authenticates and another user cannot take over a session", async t => {
    const { transport } = await connect(t);
    for (const method of ["POST", "GET", "DELETE"]) {
        for (const [subject, expected] of [[null, 401], ["bob", 404]]) {
            const headers = { "mcp-session-id": transport.sessionId, "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
            if (subject) headers["x-test-user"] = subject;
            const response = await fetch(endpoint, { method, headers, ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) } : {}) });
            assert.equal(response.status, expected);
            if (expected === 401) assert.match(response.headers.get("www-authenticate"), /https:\/\/demo.example.com/);
            await response.text();
        }
    }
    const id = transport.sessionId;
    await transport.terminateSession();
    const response = await fetch(endpoint, { headers: { "x-test-user": "alice", "mcp-session-id": id } });
    assert.equal(response.status, 404);
    await response.text();
});

test("all six existing tool names remain available", async t => {
    const { client } = await connect(t);
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), ["confirm_job_creation", "confirm_job_update", "create_job", "get_job_details", "search_jobs", "update_job"]);
});
