import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requestContext } from "./requestcontext.js";

export function createMcpHandler(createServer, authenticate, {
    publicBaseUrl = "http://localhost:3000", sessionTtlMs = 3_600_000, maxSessions = 250
} = {}) {
    const sessions = new Map();
    const activeServers = new Set();
    const cleanup = setInterval(() => {
        for (const session of sessions.values()) {
            if (session.active === 0 && Date.now() - session.lastUsed > sessionTtlMs) {
                void session.server.close().catch(() => {});
            }
        }
    }, 60_000).unref();

    const handler = async (req, res) => {
        try {
            const user = await authenticate(req);
            if (!user?.sub) {
                res.setHeader(
                    "WWW-Authenticate",
                    `Bearer resource_metadata="${publicBaseUrl}/.well-known/oauth-protected-resource"`
                );
                return res.status(401).json({
                    jsonrpc: "2.0",
                    error: { code: -32001, message: "Authentication required" },
                    id: req.body?.id ?? null
                });
            }

            const sessionId = req.headers["mcp-session-id"];
            let session = sessions.get(sessionId);
            if (sessionId && (!session || session.subject !== user.sub)) {
                return res.status(404).json({
                    jsonrpc: "2.0",
                    error: { code: -32001, message: "Session not found" },
                    id: req.body?.id ?? null
                });
            }

            if (!session) {
                if (req.method !== "POST" || !isInitializeRequest(req.body)) {
                    return res.status(400).json({
                        jsonrpc: "2.0",
                        error: { code: -32000, message: "Initialize an MCP session first" },
                        id: req.body?.id ?? null
                    });
                }

                if (activeServers.size >= maxSessions) {
                    return res.status(503).json({ error: "Too many sessions. Try again later." });
                }
                const server = createServer(user);
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: id => sessions.set(id, session)
                });
                session = { transport, server, subject: user.sub, lastUsed: Date.now(), active: 0 };
                activeServers.add(server);
                transport.onclose = () => {
                    sessions.delete(transport.sessionId);
                    activeServers.delete(server);
                };
                try { await server.connect(transport); }
                catch (error) { activeServers.delete(server); await server.close(); throw error; }
            }

            // Keep the transport alive across POST responses for confirmation replies.
            session.lastUsed = Date.now();
            // A GET SSE stream alone should not keep an unused session alive forever.
            if (req.method === "POST") {
                session.active++;
                res.once("close", () => { session.active--; session.lastUsed = Date.now(); });
            }
            try {
                await requestContext.run(user, () => session.transport.handleRequest(req, res, req.body));
            } finally {
                if (!session.transport.sessionId) await session.server.close();
            }
        } catch (error) {
            console.error("MCP request error:", error.code ?? error.name);
            if (!res.headersSent) {
                res.status(500).json({ error: "MCP server error" });
            }
        }
    };
    handler.close = async () => {
        clearInterval(cleanup);
        await Promise.allSettled([...activeServers].map(server => server.close()));
        sessions.clear();
        activeServers.clear();
    };
    return handler;
}
