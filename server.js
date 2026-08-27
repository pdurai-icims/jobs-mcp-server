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

    // This description tells Claude WHEN to call your tool
    "Search for job listings. Use this whenever the user asks about jobs, " +
    "vacancies, salaries, or career opportunities.",

    // These are the parameters Claude will fill in
    {
        query: z.string().describe("Job title or keyword e.g. 'React developer'"),
        location: z.string().optional().describe("City or 'Remote'"),
        limit: z.number().optional().describe("Max results to return, default 5")
    },

    // This function runs when Claude calls your tool
    async ({ query, location, limit = 5 }) => {

        // ── Call YOUR actual jobs API here ──
        const params = new URLSearchParams({ q: query, limit });
        if (location) params.append("location", location);

        const res = await fetch(
            `https://your-jobs-api.com/search?${params}`,
            {
                headers: {
                    "Authorization": `Bearer ${process.env.JOBS_API_KEY}`,
                    "Content-Type": "application/json"
                }
            }
        );

        if (!res.ok) {
            return {
                content: [{
                    type: "text",
                    text: `Error fetching jobs: ${res.statusText}`
                }]
            };
        }

        const data = await res.json();

        // Return result to Claude — Claude will format it for the user
        return {
            content: [{
                type: "text",
                text: JSON.stringify(data, null, 2)
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

// Tool 2 — Get job details

server.tool(

  "get_job_details",

  "Get full details of a specific job listing by ID.",

  { job_id: z.string().describe("The job listing ID") },

  async ({ job_id }) => {

    const res  = await fetch(`https://your-jobs-api.com/jobs/${job_id}`);

    const data = await res.json();

    return { content: [{ type: "text", text: JSON.stringify(data) }] };

  }

);
 
// Tool 3 — Get salary info

server.tool(

  "get_salary_data",

  "Get average salary data for a job role in a specific city.",

  {

    role: z.string().describe("Job title e.g. 'Data Analyst'"),

    city: z.string().optional().describe("City name")

  },

  async ({ role, city }) => {

    const res  = await fetch(`https://your-jobs-api.com/salaries?role=${role}&city=${city}`);

    const data = await res.json();

    return { content: [{ type: "text", text: JSON.stringify(data) }] };

  }

);
 