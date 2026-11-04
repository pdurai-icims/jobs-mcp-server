import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { requestContext } from "./requestcontext.js";

export function createMcpHandler(createServer, authenticate) {
    const sessions = new Map();

    return async (req, res) => {
        try {
            const user = await authenticate(req);
            if (!user?.sub) {
                res.setHeader(
                    "WWW-Authenticate",
                    'Bearer resource_metadata="https://jobs-mcp-server.onrender.com/.well-known/oauth-protected-resource"'
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

                const server = createServer();
                const transport = new StreamableHTTPServerTransport({
                    sessionIdGenerator: () => randomUUID(),
                    onsessioninitialized: id => sessions.set(id, session)
                });
                session = { transport, subject: user.sub };
                transport.onclose = () => sessions.delete(transport.sessionId);
                await server.connect(transport);
            }

            // Keep the transport alive across POST responses for confirmation replies.
            await requestContext.run(user, () => session.transport.handleRequest(req, res, req.body));
        } catch (error) {
            console.error("MCP request error:", error);
            if (!res.headersSent) {
                res.status(500).json({ error: "MCP server error", message: error.message });
            }
        }
    };
}
