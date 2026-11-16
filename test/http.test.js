import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { createApp } from "../server.js";
import { readConfig } from "../config.js";

const env = {
    PUBLIC_BASE_URL: "https://jobs.example.com/",
    AUTH0_ISSUER: "https://auth.example.com",
    AUTH0_AUDIENCE: "existing-api-identifier"
};

async function start(t, overrides = {}) {
    const service = createApp({ jobs: {}, config: readConfig(env), authenticate: async () => null, ...overrides });
    let listener;
    await new Promise((resolve, reject) => { listener = service.app.listen(0, "127.0.0.1", error => error ? reject(error) : resolve()); });
    t.after(async () => {
        await service.close();
        await new Promise(resolve => { listener.close(resolve); listener.closeAllConnections(); });
    });
    return `http://127.0.0.1:${listener.address().port}`;
}

test("config validates origins and reports names without leaking values", () => {
    const config = readConfig(env);
    assert.equal(config.PUBLIC_BASE_URL, "https://jobs.example.com");
    assert.equal(config.AUTH0_ISSUER, "https://auth.example.com/");
    for (const value of ["http://public.example.com", "https://user:secret@host", "https://host/mcp", "https://host?token=secret"]) {
        assert.throws(() => readConfig({ ...env, PUBLIC_BASE_URL: value }), error => {
            assert.match(error.message, /PUBLIC_BASE_URL/);
            assert.doesNotMatch(error.message, /secret/);
            return true;
        });
    }
    // A resource server must not require OAuth client credentials.
    assert.equal(config.AUTH0_CLIENT_ID, undefined);
    assert.equal(config.AUTH0_CLIENT_SECRET, undefined);
});

test("protected-resource discovery identifies the real Auth0 issuer exactly", async t => {
    const base = await start(t);
    for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
        const response = await fetch(base + path, { headers: { Host: "attacker.example" } });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const metadata = await response.json();
        assert.equal(metadata.resource, "https://jobs.example.com/mcp");
        // The trailing slash matches Auth0's discovery and RFC 9207 response iss.
        assert.deepEqual(metadata.authorization_servers, ["https://auth.example.com/"]);
        assert.deepEqual(metadata.bearer_methods_supported, ["header"]);
        assert.notEqual(metadata.authorization_servers[0], new URL(metadata.resource).origin);
    }
    const unauthenticated = await fetch(`${base}/mcp`);
    assert.equal(unauthenticated.status, 401);
    assert.match(unauthenticated.headers.get("www-authenticate"), /jobs.example.com/);
    await unauthenticated.text();
});

test("MCP does not impersonate the authorization server or accept token exchanges", async t => {
    const base = await start(t);
    for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/openid-configuration", "/authorize"]) {
        const response = await fetch(base + path, { redirect: "manual" });
        assert.equal(response.status, 404);
        assert.equal(response.headers.has("location"), false);
        await response.text();
    }
    for (const grant_type of ["authorization_code", "refresh_token"]) {
        const response = await fetch(`${base}/token`, {
            method: "POST", body: new URLSearchParams({ grant_type, code: "test", refresh_token: "test" })
        });
        assert.equal(response.status, 404);
        await response.text();
    }
});

test("readiness fails when the database is unavailable", async t => {
    const base = await start(t, { checkDatabase: async () => { throw new Error("private-host"); } });
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { status: "database_unavailable" });
});

test("Compose keeps PostgreSQL private and persists it outside containers", async () => {
    const compose = parse(await readFile(new URL("../compose.yaml", import.meta.url), "utf8"));
    assert.equal(compose.services.db.ports, undefined);
    assert.ok(compose.services.db.volumes.includes("jobs_data:/var/lib/postgresql/data"));
    assert.equal(compose.services.mcp.depends_on.db.condition, "service_healthy");
    assert.equal(compose.services.mcp.environment.DATABASE_URL, "");
    assert.equal(compose.services.mcp.environment.PGHOST, "db");
    assert.deepEqual(compose.services.tunnel.profiles, ["tunnel"]);
});
