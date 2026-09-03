import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const app = express();
app.use(express.json());

// ── Create MCP server ──
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
            const params = new URLSearchParams({ offset: "0", limit: String(limit) });

            const res = await fetch(
                `https://jobs-api-9203.onrender.com/jobs?${params}`,
                // `https://saalqngddakjvqnuldjf.supabase.co/rest/v1/jobs`,
                // `https://job-service-ipipeline.staging.icimsmco.net/jobs?${params}`,
                {
                    headers: {
                        // "Authorization": `Bearer ${process.env.JOBS_API_KEY}`,
                        "Content-Type": "application/json",
                        // "apikey": "sb_publishable_Faugw9G95-KhZErI_7O0qA_6g_jVapr",
                        // "Cookie": "__cf_bm=jKBIf4U1L3VqKq2JmCXjCuomv0.ikLQ9CwcTzboZKyg-1785390106.3807838-1.0.1.1-9rOK8esw8iUbVM3H6qFudC_2zezfaJHyFsodkU_GRJBt4zBb0jjz73AktNFTgcl2LbA7vkXO7A3NykKur0McXK7A2lEJ1nFpFeAuh7.fGL2zqk2jNxPzguiT9V7uHebd"
                        // "Accept": "application/json",
                        // "X-Jibe-Client": "mortonfinancial"
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

// ── Tool 2: Get job details ──
server.tool(
    "get_job_details",
    "Get full details of a specific job listing by slug or req_id.",
    { job_id: z.string().describe("The job listing slug or req_id") },
    async ({ job_id }) => {
        try {
            const res = await fetch(
                `https://job-service-ipipeline.staging.icimsmco.net/jobs?offset=1&limit=100`,
                {
                    headers: {
                        "Accept": "application/json",
                        "X-Jibe-Client": "mortonfinancial"
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

// ── Tool 3: Get salary info ──
server.tool(
    "get_salary_data",
    "Get average salary data for a job role in a specific city.",
    {
        role: z.string().describe("Job title e.g. 'Data Analyst'"),
        city: z.string().optional().describe("City name")
    },
    async ({ role, city }) => {
        return {
            content: [{
                type: "text",
                text: JSON.stringify({ message: "Salary benchmarks service not connected.", role, city })
            }]
        };
    }
);

// ── MCP HTTP endpoint ──
// Claude.ai connects to this URL
app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined
    });

    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
});

// Health check — useful for deployment platforms
app.get("/", (req, res) => {
    res.json({ status: "ok", name: "Jobs MCP Server" });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP server running on port ${PORT}`);
});
