import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import express from "express";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ElicitRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createJobsServer } from "../server.js";
import { createMcpHandler } from "../middleware/mcp.js";

const originalFetch = globalThis.fetch;
let listener;
let endpoint;

before(async () => {
    const app = express();
    app.use(express.json());
    const handler = createMcpHandler(createJobsServer, async req => {
        const subject = req.headers["x-test-user"];
        return subject ? { sub: subject } : null;
    });
    app.post("/mcp", handler);
    app.get("/mcp", handler);
    app.delete("/mcp", handler);
    await new Promise(resolve => {
        listener = app.listen(0, "127.0.0.1", resolve);
    });
    endpoint = new URL(`http://127.0.0.1:${listener.address().port}/mcp`);
});

after(async () => {
    await new Promise((resolve, reject) => {
        listener.close(error => error ? reject(error) : resolve());
        listener.closeAllConnections();
    });
});

async function connect(t, confirm, subject = "user-one") {
    const client = new Client(
        { name: "jobs-test", version: "1.0.0" },
        { capabilities: confirm ? { elicitation: { form: {} } } : {} }
    );
    if (confirm) {
        client.setRequestHandler(ElicitRequestSchema, confirm);
    }
    const transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { "x-test-user": subject } }
    });
    await client.connect(transport);
    t.after(async () => {
        await transport.terminateSession();
        await client.close();
    });
    return { client, transport };
}

function mockJobsApi(t, respond = () => Response.json({ success: true, job: { slug: "developer" } })) {
    const calls = [];
    t.mock.method(globalThis, "fetch", async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        if (url.origin === endpoint.origin) {
            return originalFetch(input, init);
        }
        assert.equal(url.origin, "https://jobs-api-9203.onrender.com");
        calls.push({ url: url.href, ...init });
        return respond(input, init);
    });
    return calls;
}

const approve = () => ({ action: "accept", content: { confirm: true } });
const update = (client, updates = { title: "Senior Developer" }, slug = "developer") =>
    client.callTool({ name: "update_job", arguments: { slug, updates } });
const confirmUpdate = (client, confirmation_id, confirm = true) =>
    client.callTool({ name: "confirm_job_update", arguments: { confirmation_id, confirm } });

const newJob = { title: "Developer", description: "Build applications", experience: "3 years" };
const create = (client, job = newJob) =>
    client.callTool({ name: "create_job", arguments: job });
const confirmCreation = (client, confirmation_id, confirm = true) =>
    client.callTool({ name: "confirm_job_creation", arguments: { confirmation_id, confirm } });
const createdResponse = () => Response.json({ success: true, job: { id: 42, ...newJob } });

test("creation previews every supplied field and waits for explicit dialog approval", { timeout: 15000 }, async t => {
    const calls = mockJobsApi(t, createdResponse);
    let approveDialog;
    let dialogShown;
    const shown = new Promise(resolve => { dialogShown = resolve; });
    const job = {
        ...newJob, city: "Chennai", state: "Tamil Nadu", country: "India",
        skills: ["React"], employment_type: "Full-time", job_type: "Hybrid",
        industry: "Software", education_level: "Degree", salary_value: 0, salary_currency: "INR"
    };
    const { client } = await connect(t, request => {
        assert.deepEqual(JSON.parse(request.params.message.split("\n").slice(1).join("\n")), job);
        assert.equal(request.params.requestedSchema.properties.confirm.default, false);
        dialogShown();
        return new Promise(resolve => { approveDialog = resolve; });
    });
    const pending = create(client, job);
    await shown;
    assert.equal(calls.length, 0);
    approveDialog(approve());
    const result = await pending;
    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].url, "https://jobs-api-9203.onrender.com/jobs");
    assert.deepEqual(JSON.parse(calls[0].body), job);
    const data = JSON.parse(result.content[0].text);
    assert.equal(data.job_id, 42);
    assert.deepEqual(data.job, { id: 42, ...newJob });
});

for (const confirmation of [
    { action: "decline" }, { action: "cancel" },
    { action: "accept", content: { confirm: false } },
    { action: "accept", content: {} },
    { action: "accept", content: { confirm: "true" } }
]) {
    test(`does not create for ${JSON.stringify(confirmation)}`, async t => {
        const calls = mockJobsApi(t, createdResponse);
        const { client } = await connect(t, () => confirmation);
        const result = await create(client);
        assert.equal(calls.length, 0);
        assert.match(result.content[0].text, /cancelled|Unable to complete/);
    });
}

test("creation chat previews are session-bound, immutable, replaceable, and single-use", async t => {
    const calls = mockJobsApi(t, createdResponse);
    const { client } = await connect(t);
    const other = await connect(t);
    const old = JSON.parse((await create(client)).content[0].text);
    const preview = JSON.parse((await create(client, { ...newJob, title: "Senior Developer" })).content[0].text);
    assert.equal(preview.status, "confirmation_required");
    assert.match(preview.message, /STOP until the user replies/);
    assert.equal(calls.length, 0);
    assert.equal((await confirmCreation(client, old.confirmation_id)).isError, true);
    assert.equal((await confirmCreation(other.client, preview.confirmation_id)).isError, true);
    for (const args of [
        { confirmation_id: preview.confirmation_id },
        { confirmation_id: preview.confirmation_id, confirm: "true" },
        { confirmation_id: preview.confirmation_id, confirm: true, job: newJob }
    ]) {
        assert.equal((await client.callTool({ name: "confirm_job_creation", arguments: args })).isError, true);
    }
    assert.equal(calls.length, 0);
    assert.equal((await confirmCreation(client, preview.confirmation_id)).isError, false);
    assert.deepEqual(JSON.parse(calls[0].body), preview.job);
    assert.equal((await confirmCreation(client, preview.confirmation_id)).isError, true);
    assert.equal(calls.length, 1);
    const cancelled = JSON.parse((await create(client)).content[0].text);
    assert.match((await confirmCreation(client, cancelled.confirmation_id, false)).content[0].text, /cancelled/);
    assert.equal((await confirmCreation(client, cancelled.confirmation_id)).isError, true);
    assert.equal(calls.length, 1);
});

test("creation validates required and optional values before presenting a preview", async t => {
    const calls = mockJobsApi(t, createdResponse);
    const { client } = await connect(t, () => assert.fail("Invalid inputs must not show a dialog"));
    for (const field of ["title", "description", "experience"]) {
        const job = { ...newJob };
        delete job[field];
        assert.equal((await create(client, job)).isError, true);
    }
    for (const invalid of [
        { title: " " }, { description: "" }, { experience: " " },
        { city: " " }, { state: 1 }, { country: null }, { skills: [" "] },
        { skills: "React" }, { employment_type: "" }, { job_type: " " },
        { industry: "" }, { education_level: "" }, { salary_value: -1 },
        { salary_value: "100" }, { salary_currency: "XYZ" }, { salary_currency: "US" },
        { unknown: true }
    ]) {
        assert.equal((await create(client, { ...newJob, ...invalid })).isError, true);
    }
    assert.equal(calls.length, 0);
});

test("configured creation defaults appear in previews and explicit values override them", async t => {
    const settings = {
        DEFAULT_EMPLOYMENT_TYPE: "Full-time",
        DEFAULT_JOB_TYPE: "On-site",
        DEFAULT_SALARY_CURRENCY: "usd"
    };
    for (const [key, value] of Object.entries(settings)) {
        const previous = process.env[key];
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
        process.env[key] = value;
    }
    const calls = mockJobsApi(t, createdResponse);
    const { client } = await connect(t);
    const { tools } = await client.listTools();
    const schema = tools.find(tool => tool.name === "create_job").inputSchema;
    assert.deepEqual(schema.required, ["title", "description", "experience"]);
    assert.equal(schema.properties.employment_type.default, "Full-time");
    assert.equal(schema.properties.job_type.default, "On-site");
    assert.equal(schema.properties.salary_currency.default, "USD");
    const preview = JSON.parse((await create(client)).content[0].text);
    assert.deepEqual(preview.job, {
        ...newJob, employment_type: "Full-time", job_type: "On-site", salary_currency: "USD"
    });
    const explicit = JSON.parse((await create(client, {
        ...newJob, title: " Developer ", employment_type: "Contract", job_type: "Remote", salary_currency: "inr"
    })).content[0].text);
    assert.deepEqual(explicit.job, {
        ...newJob, employment_type: "Contract", job_type: "Remote", salary_currency: "INR"
    });
    assert.equal((await confirmCreation(client, explicit.confirmation_id)).isError, false);
    assert.deepEqual(JSON.parse(calls[0].body), explicit.job);
});

test("unconfigured optional creation fields remain omitted and invalid defaults fail explicitly", async t => {
    for (const key of ["DEFAULT_EMPLOYMENT_TYPE", "DEFAULT_JOB_TYPE", "DEFAULT_SALARY_CURRENCY"]) {
        const previous = process.env[key];
        t.after(() => {
            if (previous === undefined) delete process.env[key];
            else process.env[key] = previous;
        });
        delete process.env[key];
    }
    const calls = mockJobsApi(t, createdResponse);
    const { client } = await connect(t);
    assert.deepEqual(JSON.parse((await create(client)).content[0].text).job, newJob);
    assert.equal(calls.length, 0);
    process.env.DEFAULT_SALARY_CURRENCY = "INVALID";
    assert.throws(() => createJobsServer(), /currency|format/i);
});

for (const [name, respond] of [
    ["HTTP failure", () => new Response("Unavailable", { status: 503 })],
    ["network failure", () => { throw new Error("Connection lost"); }],
    ["invalid JSON", () => new Response("not JSON")],
    ["missing ID", () => Response.json({ success: true, job: newJob })],
    ["empty ID", () => Response.json({ job: { id: " " } })],
    ["explicit failure", () => Response.json({ success: false, job: { id: 42 } })]
]) {
    test(`creation surfaces ${name} and consumes confirmation`, async t => {
        const calls = mockJobsApi(t, respond);
        const { client } = await connect(t);
        const preview = JSON.parse((await create(client)).content[0].text);
        const result = await confirmCreation(client, preview.confirmation_id);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Check existing jobs before retrying/);
        assert.equal((await confirmCreation(client, preview.confirmation_id)).isError, true);
        assert.equal(calls.length, 1);
    });
}

test("update waits for explicit approval and PATCHes only the displayed changes", { timeout: 15000 }, async t => {
    const calls = mockJobsApi(t);
    let approveDialog;
    let dialogShown;
    const shown = new Promise(resolve => { dialogShown = resolve; });
    const updates = {
        title: "Senior Developer", city: null, salary_value: 0,
        skills: [], searchable: false, applyable: true
    };
    const { client } = await connect(t, request => {
        assert.equal(request.params.mode, "form");
        assert.match(request.params.message, /developer\/special\?id=1/);
        assert.deepEqual(JSON.parse(request.params.message.slice(request.params.message.indexOf("\n") + 1)), updates);
        assert.equal(request.params.requestedSchema.properties.confirm.default, false);
        assert.deepEqual(request.params.requestedSchema.required, ["confirm"]);
        dialogShown();
        return new Promise(resolve => { approveDialog = resolve; });
    });
    const pending = update(client, updates, "developer/special?id=1");
    await shown;
    assert.equal(calls.length, 0);
    approveDialog(approve());
    const result = await pending;
    assert.equal(result.isError, false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://jobs-api-9203.onrender.com/jobs/developer%2Fspecial%3Fid%3D1");
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].body), updates);
    assert.equal(JSON.parse(result.content[0].text).success, true);
});

for (const confirmation of [
    { action: "decline" },
    { action: "cancel" },
    { action: "accept", content: { confirm: false } },
    { action: "accept" },
    { action: "accept", content: {} },
    { action: "accept", content: { confirm: "true" } }
]) {
    test(`does not update for ${JSON.stringify(confirmation)}`, async t => {
        const calls = mockJobsApi(t);
        const { client } = await connect(t, () => confirmation);
        const result = await update(client);
        assert.equal(calls.length, 0);
        assert.match(result.content[0].text, /cancelled|Unable to complete/);
    });
}

test("clients without dialogs preview changes, then apply only after separate confirmation", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t);
    const updates = { title: "Senior Developer", salary_value: null, skills: [], searchable: false };
    const result = await update(client, updates, "developer/special?id=1");
    assert.equal(result.isError, false);
    const preview = JSON.parse(result.content[0].text);
    assert.equal(preview.status, "confirmation_required");
    assert.equal(preview.slug, "developer/special?id=1");
    assert.deepEqual(preview.updates, updates);
    assert.match(preview.message, /STOP until the user replies/);
    assert.equal(calls.length, 0);

    const confirmed = await confirmUpdate(client, preview.confirmation_id);
    assert.equal(confirmed.isError, false);
    assert.equal(JSON.parse(confirmed.content[0].text).success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://jobs-api-9203.onrender.com/jobs/developer%2Fspecial%3Fid%3D1");
    assert.equal(calls[0].method, "PATCH");
    assert.deepEqual(JSON.parse(calls[0].body), updates);
    assert.equal((await confirmUpdate(client, preview.confirmation_id)).isError, true);
    assert.equal(calls.length, 1);
});

test("chat cancellation consumes the confirmation without updating", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t);
    const preview = JSON.parse((await update(client)).content[0].text);
    const cancelled = await confirmUpdate(client, preview.confirmation_id, false);
    assert.match(cancelled.content[0].text, /cancelled/);
    assert.equal((await confirmUpdate(client, preview.confirmation_id)).isError, true);
    assert.equal(calls.length, 0);
});

test("chat confirmation requires a valid preview and explicit boolean without replacement fields", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t);
    assert.equal((await confirmUpdate(client, randomUUID())).isError, true);
    const preview = JSON.parse((await update(client)).content[0].text);
    for (const args of [
        { confirmation_id: preview.confirmation_id },
        { confirmation_id: preview.confirmation_id, confirm: "true" },
        { confirmation_id: preview.confirmation_id, confirm: true, slug: "other-job" },
        { confirmation_id: preview.confirmation_id, confirm: true, updates: { title: "Changed" } },
        { confirmation_id: randomUUID(), confirm: true }
    ]) {
        const result = await client.callTool({ name: "confirm_job_update", arguments: args });
        assert.equal(result.isError, true);
    }
    assert.equal(calls.length, 0);
    assert.equal((await confirmUpdate(client, preview.confirmation_id)).isError, false);
    assert.deepEqual(JSON.parse(calls[0].body), preview.updates);
});

test("new previews replace older pending changes", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t);
    const first = JSON.parse((await update(client, { title: "Old" }, "old-job")).content[0].text);
    const second = JSON.parse((await update(client, { title: "New" }, "new-job")).content[0].text);
    assert.notEqual(first.confirmation_id, second.confirmation_id);
    assert.equal((await confirmUpdate(client, first.confirmation_id)).isError, true);
    assert.equal(calls.length, 0);
    assert.equal((await confirmUpdate(client, second.confirmation_id)).isError, false);
    assert.ok(calls[0].url.endsWith("/new-job"));
    assert.deepEqual(JSON.parse(calls[0].body), { title: "New" });
});

test("chat confirmations cannot be used in other sessions, even for the same user", async t => {
    const calls = mockJobsApi(t);
    const first = await connect(t);
    const second = await connect(t);
    const third = await connect(t, undefined, "user-two");
    const preview = JSON.parse((await update(first.client)).content[0].text);
    for (const { client } of [second, third]) {
        assert.equal((await confirmUpdate(client, preview.confirmation_id)).isError, true);
    }
    assert.equal(calls.length, 0);
    assert.equal((await confirmUpdate(first.client, preview.confirmation_id)).isError, false);
    assert.equal(calls.length, 1);
});

test("duplicate concurrent chat confirmations send only one PATCH", { timeout: 15000 }, async t => {
    let finishUpdate;
    let apiStarted;
    const started = new Promise(resolve => { apiStarted = resolve; });
    const calls = mockJobsApi(t, () => {
        apiStarted();
        return new Promise(resolve => { finishUpdate = resolve; });
    });
    const { client } = await connect(t);
    const preview = JSON.parse((await update(client)).content[0].text);
    const pending = confirmUpdate(client, preview.confirmation_id);
    await started;
    assert.equal((await confirmUpdate(client, preview.confirmation_id)).isError, true);
    finishUpdate(Response.json({ success: true, job: { slug: preview.slug } }));
    assert.equal((await pending).isError, false);
    assert.equal(calls.length, 1);
});

test("failed chat updates report errors and cannot reuse the confirmation", async t => {
    const calls = mockJobsApi(t, () => new Response("Update failed", { status: 500 }));
    const { client } = await connect(t);
    const preview = JSON.parse((await update(client)).content[0].text);
    const failed = await confirmUpdate(client, preview.confirmation_id);
    assert.equal(failed.isError, true);
    assert.match(failed.content[0].text, /HTTP 500/);
    assert.equal((await confirmUpdate(client, preview.confirmation_id)).isError, true);
    assert.equal(calls.length, 1);
});

test("invalid updates cannot create a chat preview", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t);
    for (const updates of [{}, { title: " " }, { unknown: true }]) {
        assert.equal((await update(client, updates)).isError, true);
    }
    assert.equal((await confirmUpdate(client, randomUUID())).isError, true);
    assert.equal(calls.length, 0);
});

test("invalid updates are rejected before confirmation or API calls", async t => {
    const calls = mockJobsApi(t);
    let dialogs = 0;
    const { client } = await connect(t, () => { dialogs++; return approve(); });
    for (const updates of [
        {}, { title: " " }, { description: null }, { unknown: true },
        { title: "Valid", slug: "other" }, { skills: "Java" },
        { skills: [1] }, { salary_value: "abc" }, { searchable: "true" },
        { applyable: null }, { experience: 3 }
    ]) {
        const result = await update(client, updates);
        assert.equal(result.isError, true, JSON.stringify(updates));
    }
    for (const slug of [" ", ".", ".."]) {
        assert.equal((await update(client, { city: "Chennai" }, slug)).isError, true);
    }
    assert.equal(dialogs, 0);
    assert.equal(calls.length, 0);
});

test("supports every editable API field including nullable values", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t, approve);
    const updates = {
        title: "Developer", description: "Build software",
        city: null, state: null, country: null, experience: null,
        employment_type: null, job_type: null, industry: null,
        education_level: null, salary_currency: null, salary_value: null,
        skills: ["Java"], searchable: true, applyable: false
    };
    assert.equal((await update(client, updates)).isError, false);
    assert.deepEqual(JSON.parse(calls[0].body), updates);
});

for (const status of [400, 404, 500]) {
    test(`reports API HTTP ${status} without success`, async t => {
        mockJobsApi(t, () => new Response("Update failed", { status }));
        const { client } = await connect(t, approve);
        const result = await update(client);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, new RegExp(`HTTP ${status}`));
    });
}

for (const failure of ["network", "invalid JSON", "invalid shape", "dialog"]) {
    test(`reports ${failure} failures explicitly`, async t => {
        const calls = mockJobsApi(t, () => {
            if (failure === "network") throw new Error("Connection unavailable");
            if (failure === "invalid JSON") return new Response("not json");
            return Response.json({ success: true });
        });
        const { client } = await connect(t, () => {
            if (failure === "dialog") throw new Error("Dialog unavailable");
            return approve();
        });
        const result = await update(client);
        assert.equal(result.isError, true);
        assert.match(result.content[0].text, /Unable to complete or verify/);
        assert.equal(calls.length, failure === "dialog" ? 0 : 1);
    });
}

test("isolates overlapping confirmation dialogs between sessions", { timeout: 15000 }, async t => {
    const calls = mockJobsApi(t);
    let finishFirst;
    let dialogShown;
    const shown = new Promise(resolve => { dialogShown = resolve; });
    const first = await connect(t, () => {
        dialogShown();
        return new Promise(resolve => { finishFirst = resolve; });
    });
    const second = await connect(t, approve, "user-two");
    const pending = update(first.client, { city: "Chennai" }, "first-job");
    await shown;
    assert.equal((await update(second.client, { city: "Seattle" }, "second-job")).isError, false);
    finishFirst({ action: "decline" });
    assert.match((await pending).content[0].text, /cancelled/);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith("/second-job"));
});

test("authenticates session requests and rejects another user's session access", async t => {
    mockJobsApi(t);
    const { client, transport } = await connect(t, approve);
    for (const method of ["POST", "GET", "DELETE"]) {
        for (const [subject, status] of [[null, 401], ["user-two", 404]]) {
            const headers = {
                "mcp-session-id": transport.sessionId,
                "Content-Type": "application/json",
                "Accept": "application/json, text/event-stream"
            };
            if (subject) headers["x-test-user"] = subject;
            const response = await originalFetch(endpoint, {
                method, headers,
                ...(method === "POST" ? { body: JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" }) } : {})
            });
            assert.equal(response.status, status);
            await response.text();
        }
    }
    assert.equal((await update(client)).isError, false);
    const sessionId = transport.sessionId;
    await transport.terminateSession();
    const response = await originalFetch(endpoint, {
        headers: { "x-test-user": "user-one", "mcp-session-id": sessionId }
    });
    assert.equal(response.status, 404);
    await response.text();
});

test("existing search, details and create tools still work", async t => {
    const job = { id: 42, slug: "developer", req_id: "REQ-1", title: "Developer", description: "Build", city: "Chennai" };
    const calls = mockJobsApi(t, (_url, init) =>
        Response.json(init?.method === "POST" ? { job } : { jobs: [job] })
    );
    const { client } = await connect(t);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
        "confirm_job_creation", "confirm_job_update", "create_job", "get_job_details", "search_jobs", "update_job"
    ]);
    const search = await client.callTool({
        name: "search_jobs", arguments: { query: "Developer", location: "Chennai" }
    });
    assert.equal(JSON.parse(search.content[0].text).count, 1);
    const details = await client.callTool({ name: "get_job_details", arguments: { job_id: "REQ-1" } });
    assert.equal(JSON.parse(details.content[0].text).slug, "developer");
    const previewResult = await client.callTool({
        name: "create_job", arguments: { title: "Developer", description: "Build", experience: "3 years" }
    });
    const preview = JSON.parse(previewResult.content[0].text);
    assert.equal(preview.status, "confirmation_required");
    assert.equal(calls.length, 2);
    const created = await confirmCreation(client, preview.confirmation_id);
    assert.equal(JSON.parse(created.content[0].text).success, true);
    assert.equal(calls.length, 3);
});
