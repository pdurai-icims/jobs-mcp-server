import assert from "node:assert/strict";
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

test("clients without confirmation support cannot update", async t => {
    const calls = mockJobsApi(t);
    const { client } = await connect(t);
    const result = await update(client);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /does not support/);
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
    const job = { slug: "developer", req_id: "REQ-1", title: "Developer", description: "Build", city: "Chennai" };
    const calls = mockJobsApi(t, (_url, init) =>
        Response.json(init?.method === "POST" ? { job } : { jobs: [job] })
    );
    const { client } = await connect(t);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map(tool => tool.name).sort(), [
        "create_job", "get_job_details", "search_jobs", "update_job"
    ]);
    const search = await client.callTool({
        name: "search_jobs", arguments: { query: "Developer", location: "Chennai" }
    });
    assert.equal(JSON.parse(search.content[0].text).count, 1);
    const details = await client.callTool({ name: "get_job_details", arguments: { job_id: "REQ-1" } });
    assert.equal(JSON.parse(details.content[0].text).slug, "developer");
    const created = await client.callTool({
        name: "create_job", arguments: { title: "Developer", description: "Build", experience: "3 years" }
    });
    assert.equal(JSON.parse(created.content[0].text).success, true);
    assert.equal(calls.length, 3);
});
