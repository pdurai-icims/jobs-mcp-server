import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { getAuthenticatedUser } from "./middleware/auth.js";
import { createMcpHandler } from "./middleware/mcp.js";
import { registerUpdateJob } from "./update-job.js";
import { registerCreateJob } from "./create-job.js";

const app = express();
app.use(express.json());

// ── Create MCP server ──
export function createJobsServer() {
const server = new McpServer({
    name: "jobs-mcp",
    version: "1.0.0"
});

// ── Define your jobs tool ──
server.tool(
    "search_jobs",

    `Search for job postings based on the user's requirements.

Use this tool whenever the user wants to find jobs.

Examples:
- "Find React developer jobs"
- "Show senior Java jobs in Seattle"
- "Find jobs in Chennai"
- "Find jobs requiring SQL"
- "Show developer jobs in New York"

The tool searches the available job postings and returns matching results.`,

    {
        query: z.string().optional().describe(
            "Job title, skill, technology, role, or keyword to search for. Example: React developer"
        ),

        location: z.string().optional().describe(
            "City, state, or country where the job is located. Example: Seattle"
        ),

        limit: z.number()
            .int()
            .min(1)
            .max(20)
            .optional()
            .default(5)
            .describe(
                "Maximum number of jobs to return. Default is 5."
            )
    },

    async ({ query, location, limit = 5 }) => {
        try {
            // Fetch jobs from staging API
            const params = new URLSearchParams();
            params.set("offset", "0");
            params.set("limit", String(limit));
            if (query && query.trim()) {
                params.set("q", query);
            }
            if (location && location.trim()) {
                params.set("location", location);
            }

            const res = await fetch(
                `https://jobs-api-9203.onrender.com/jobs?${params}`,
                {
                    headers: {
                        "Content-Type": "application/json",
                    }
                }
            );

            if (!res.ok) {
                const errorText = await res.text();
                console.error(
                    `Jobs API returned ${res.status}:`,
                    errorText
                );
                return {
                    content: [
                        {
                            type: "text",
                            text: `Unable to search jobs. Jobs API returned HTTP ${res.status}.`
                        }
                    ]
                };
            }

            const data = await res.json();
            let jobs = data.jobs || [];

            // Filter by query keyword in title or description if provided
            if (query) {
                const q = query.toLowerCase();
                jobs = jobs.filter(j =>
                    (j.title && j.title.toLowerCase().includes(q)) ||
                    (j.description && j.description.toLowerCase().includes(q)) ||
                    (j.skills && j.skills.toLowerCase().includes(q))
                );
            }

            // Filter by location if provided
            if (location) {
                const loc = location.toLowerCase();
                jobs = jobs.filter(j =>
                    (j.city && j.city.toLowerCase().includes(loc)) ||
                    (j.state && j.state.toLowerCase().includes(loc)) ||
                    (j.country && j.country.toLowerCase().includes(loc)) ||
                    (j.location_type && j.location_type.toLowerCase().includes(loc))
                );
            }

            // Slice to requested limit
            const results = jobs.slice(0, limit);

            // Return result to Claude — Claude will format it for the user
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify({ count: results.length, total_found: jobs.length, jobs: results }, null, 2)
                }]
            };
        } catch (err) {
            return {
                content: [{
                    type: "text",
                    text: `Jobs API is currently unreachable or down. Details: ${err.message}${err.cause ? ` (${err.cause.message || err.cause})` : ""}`
                }]
            };
        }
    }
);


registerCreateJob(server);

// ── Tool 2: Get job details ──
server.tool(
    "get_job_details",
    "Get full details of a specific job listing by slug or req_id.",
    { job_id: z.string().describe("The job listing slug or req_id") },
    async ({ job_id }) => {
        try {
            const res = await fetch(
                `https://jobs-api-9203.onrender.com/jobs`,
                {
                    headers: {
                        "Content-Type": "application/json",
                    }
                }
            );

            if (!res.ok) {
                return {
                    content: [{ type: "text", text: `Error fetching job details: ${res.statusText}` }]
                };
            }

            const data = await res.json();
            const job = (data.jobs || []).find(j => j.slug === job_id || j.req_id === job_id);

            if (!job) {
                return {
                    content: [{ type: "text", text: `Job not found with ID/slug: ${job_id}` }]
                };
            }

            return { content: [{ type: "text", text: JSON.stringify(job, null, 2) }] };
        } catch (err) {
            return {
                content: [{
                    type: "text",
                    text: `Jobs API is currently unreachable or down. Details: ${err.message}${err.cause ? ` (${err.cause.message || err.cause})` : ""}`
                }]
            };
        }
    }
);

// ── MCP HTTP endpoint ──
registerUpdateJob(server);
return server;
}

// Claude.ai connects to this URL
const mcpHandler = createMcpHandler(createJobsServer, getAuthenticatedUser);
app.post("/mcp", mcpHandler);
app.get("/mcp", mcpHandler);
app.delete("/mcp", mcpHandler);

// Health check — useful for deployment platforms
app.get("/", (req, res) => {
    res.json({ status: "ok", name: "Jobs MCP Server" });
});

app.get("/.well-known/oauth-protected-resource", (req, res) => {
    res.json({
        resource: "https://jobs-mcp-server.onrender.com/mcp",
        authorization_servers: [
            "https://jobs-mcp-server.onrender.com"  // ← your server, not Auth0
        ],
        bearer_methods_supported: ["header"]
    });
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
    res.json({
        issuer: "https://jobs-mcp-server.onrender.com",  // ← your server
        authorization_endpoint: "https://dev-duromcyrubs02o5n.us.auth0.com/authorize",
        token_endpoint: "https://jobs-mcp-server.onrender.com/token",  // ← your proxy
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code"],
        code_challenge_methods_supported: ["S256"]
    });
});

app.post("/token", express.urlencoded({ extended: true }), async (req, res) => {
    try {
        console.log("Token proxy received:", req.body); // ← debug log

        const body = new URLSearchParams({
            ...req.body,
            client_id: process.env.AUTH0_CLIENT_ID,
            client_secret: process.env.AUTH0_CLIENT_SECRET,
            audience: "https://jobs-mcp-server.onrender.com/mcp"
        });

        const response = await fetch(
            "https://dev-duromcyrubs02o5n.us.auth0.com/oauth/token",
            {
                method: "POST",
                headers: { "Content-Type": "application/x-www-form-urlencoded" },
                body: body.toString()
            }
        );

        const data = await response.json();
        console.log("Auth0 token response:", response.status, data); // ← debug log

        res.status(response.status).json(data);
    } catch (err) {
        console.error("Token proxy error:", err);
        res.status(500).json({ error: "token_proxy_error", message: err.message });
    }
});

const PORT = process.env.PORT || 3000;
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    app.listen(PORT, () => {
        console.log(`MCP server running on port ${PORT}`);
    });
}
