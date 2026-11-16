import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createAuthenticator } from "./middleware/auth.js";
import { createMcpHandler } from "./middleware/mcp.js";
import { registerUpdateJob } from "./update-job.js";
import { registerCreateJob } from "./create-job.js";
import { toolResult, toolError } from "./tool-result.js";
import { readConfig } from "./config.js";
import { createPool, migrate } from "./db/index.js";
import { createJobRepository } from "./db/jobs.js";

export function createJobsServer({ jobs, subject }) {
    const server = new McpServer({ name: "jobs-mcp", version: "2.0.0" });
    server.registerTool("search_jobs", {
        description: "Search the shared demo job board by title, description, skills or location. All connector users see the same jobs. Only searchable jobs appear in results.",
        inputSchema: {
            query: z.string().optional(), location: z.string().optional(),
            limit: z.number().int().min(1).max(20).default(5)
        },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async input => {
        try { return toolResult(await jobs.search(input)); }
        catch (error) { return toolError("search jobs", error); }
    });
    server.registerTool("get_job_details", {
        description: "Get a job directly by UUID, exact slug, req_id or imported legacy ID, including jobs hidden from search.",
        inputSchema: { job_id: z.string().trim().min(1) },
        annotations: { readOnlyHint: true, openWorldHint: false }
    }, async ({ job_id }) => {
        try {
            const job = await jobs.get(job_id);
            return job ? toolResult(job) : toolResult("Job not found with that ID or slug.", true);
        } catch (error) { return toolError("fetch job details", error); }
    });
    registerCreateJob(server, jobs, subject);
    registerUpdateJob(server, jobs, subject);
    return server;
}

export function createApp({ jobs, config, authenticate = createAuthenticator(config), checkDatabase = async () => {} }) {
    const app = express();
    app.disable("x-powered-by");
    app.use(express.json({ limit: "128kb" }));
    const handler = createMcpHandler(user => createJobsServer({ jobs, subject: user.sub }), authenticate, {
        publicBaseUrl: config.PUBLIC_BASE_URL, sessionTtlMs: config.SESSION_TTL_MS, maxSessions: config.MAX_SESSIONS
    });
    for (const method of ["post", "get", "delete"]) app[method]("/mcp", handler);
    app.all("/mcp", (_req, res) => res.set("Allow", "POST, GET, DELETE").sendStatus(405));
    app.get("/", (_req, res) => res.json({ status: "ok", name: "Jobs MCP Server", mode: "shared-demo" }));
    app.get("/health/ready", async (_req, res) => {
        try { await checkDatabase(); res.json({ status: "ok" }); }
        catch { res.status(503).json({ status: "database_unavailable" }); }
    });
    const resourceMetadata = (_req, res) => res.set("Cache-Control", "no-store").json({
        resource: `${config.PUBLIC_BASE_URL}/mcp`,
        // Auth0 owns discovery, authorization responses and tokens. Preserve its exact issuer.
        authorization_servers: [config.AUTH0_ISSUER],
        bearer_methods_supported: ["header"]
    });
    app.get("/.well-known/oauth-protected-resource", resourceMetadata);
    app.get("/.well-known/oauth-protected-resource/mcp", resourceMetadata);
    // This is an OAuth resource server, not an authorization server. Clients
    // discover Auth0 from protected-resource metadata and exchange tokens there.
    // Do not proxy OAuth or advertise a tunnel issuer for Auth0-issued responses.
    app.use((error, _req, res, _next) => {
        const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
        res.status(status).json({ error: status === 500 ? "server_error" : "invalid_request" });
    });
    return { app, close: handler.close };
}

async function main() {
    const config = readConfig();
    const pool = createPool();
    try {
        await migrate(pool);
        const { app, close } = createApp({
            jobs: createJobRepository(pool), config,
            checkDatabase: () => pool.query("SELECT 1")
        });
        let listener;
        try {
            await new Promise((resolve, reject) => {
                listener = app.listen(config.PORT, "0.0.0.0", error => error ? reject(error) : resolve());
            });
        } catch (error) {
            await close();
            throw error;
        }
        console.log(`Jobs MCP server listening on port ${config.PORT}`);
        let stopping = false;
        async function shutdown() {
            if (stopping) return;
            stopping = true;
            const deadline = setTimeout(() => process.exit(1), 10_000).unref();
            const stopped = new Promise(resolve => listener.close(resolve));
            await close();
            await stopped;
            await pool.end();
            clearTimeout(deadline);
        }
        process.once("SIGTERM", shutdown);
        process.once("SIGINT", shutdown);
    } catch (error) {
        await pool.end();
        throw error;
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(error => {
        console.error("Startup failed:", error.code ?? error.message);
        process.exitCode = 1;
    });
}
