import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getCurrentUser, requestContext } from "./middleware/requestcontext.js";
import { getAuthenticatedUser } from "./middleware/auth.js";

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


// ── Tool 2: Create Job ──
server.tool(
    "create_job",

    `Create a new job posting in the connected Jobs API.

Use this tool when the user wants to create, add, or post a job.

Examples:
- "Create a Senior React Developer job in Chennai"
- "Add a Java Developer position in Bangalore"
- "Create a Product Manager job"

Collect the job title and description before creating the job.

Do not create a job if required information is missing.`,

    {
        title: z.string()
            .min(1)
            .describe(
                "Job title. Example: Senior React Developer"
            ),

        description: z.string()
            .min(1)
            .describe(
                "Full job description"
            ),

        city: z.string()
            .optional()
            .describe(
                "City where the job is located"
            ),

        state: z.string()
            .optional()
            .describe(
                "State or province where the job is located"
            ),

        country: z.string()
            .optional()
            .describe(
                "Country where the job is located"
            ),

        experience: z.string()
            .optional()
            .describe(
                "Experience level. Example: Entry, Junior, Mid, Senior, Lead"
            ),

        skills: z.array(z.string())
            .optional()
            .describe(
                "Required skills or technologies"
            ),

        employment_type: z.string()
            .optional()
            .describe(
                "Employment type. Example: Full-time, Part-time, Contract"
            ),

        job_type: z.string()
            .optional()
            .describe(
                "Work type. Example: Remote, Hybrid, On-site"
            ),

        industry: z.string()
            .optional()
            .describe(
                "Industry of the job"
            ),

        education_level: z.string()
            .optional()
            .describe(
                "Required education level"
            ),

        salary_value: z.number()
            .optional()
            .describe(
                "Salary amount"
            ),

        salary_currency: z.string()
            .optional()
            .describe(
                "Salary currency. Example: USD, INR"
            )
    },

    async ({
        title,
        description,
        city,
        state,
        country,
        experience,
        skills,
        employment_type,
        job_type,
        industry,
        education_level,
        salary_value,
        salary_currency
    }) => {

        try {

            const response = await fetch(
                "https://jobs-api-9203.onrender.com/jobs",
                {
                    method: "POST",

                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },

                    body: JSON.stringify({
                        title,
                        description,
                        city,
                        state,
                        country,
                        experience,
                        skills,
                        employment_type,
                        job_type,
                        industry,
                        education_level,
                        salary_value,
                        salary_currency
                    })
                }
            );

            const responseText = await response.text();

            let data;

            try {
                data = JSON.parse(responseText);
            } catch {
                data = {
                    raw: responseText
                };
            }

            if (!response.ok) {

                console.error(
                    "Jobs API create job failed:",
                    response.status,
                    data
                );

                return {
                    content: [
                        {
                            type: "text",
                            text:
                                `Unable to create job. ` +
                                `Jobs API returned HTTP ${response.status}. ` +
                                JSON.stringify(data)
                        }
                    ]
                };
            }

            console.log(
                "Job created successfully:",
                data.job?.id
            );

            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(
                            {
                                success: true,
                                message: "Job created successfully",
                                job: data.job
                            },
                            null,
                            2
                        )
                    }
                ]
            };

        } catch (error) {

            console.error(
                "create_job error:",
                error
            );

            return {
                content: [
                    {
                        type: "text",
                        text:
                            `Jobs API is currently unreachable. ` +
                            `Details: ${error.message}`
                    }
                ]
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

// ── MCP HTTP endpoint ──
// Claude.ai connects to this URL
app.post("/mcp", async (req, res) => {
    try {
        const user = await getAuthenticatedUser(req);

        // Check whether this MCP request is attempting to call create_job
        const isCreateJobRequest =
            req.body?.method === "tools/call" &&
            req.body?.params?.name === "create_job";

        // create_job requires authentication
        if (isCreateJobRequest && !user) {
            res.setHeader(
                "WWW-Authenticate",
                'Bearer resource_metadata="https://jobs-mcp-server.onrender.com/.well-known/oauth-protected-resource"'
            );

            return res.status(401).json({
                error: "Authentication required",
                message: "Authentication is required to create a job."
            });
        }

        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined
        });

        res.on("close", () => {
            transport.close();
        });

        await server.connect(transport);

        await requestContext.run(user, async () => {
            await transport.handleRequest(
                req,
                res,
                req.body
            );
        });

    } catch (error) {
        console.error("MCP request error:", error);

        if (!res.headersSent) {
            res.status(500).json({
                error: "MCP server error",
                message: error.message
            });
        }
    }
});

// Health check — useful for deployment platforms
app.get("/", (req, res) => {
    res.json({ status: "ok", name: "Jobs MCP Server" });
});

app.get(
    "/.well-known/oauth-protected-resource",
    (req, res) => {
        res.json({
            resource:
                "https://jobs-mcp-server.onrender.com/mcp",

            authorization_servers: [
                "https://dev-duromcyrubs02o5n.us.auth0.com"
            ],

            scopes_supported: [
                "jobs:read",
                "jobs:create"
            ],

            bearer_methods_supported: [
                "header"
            ]
        });
    }
);

app.get(
    "/.well-known/oauth-authorization-server",
    (req, res) => {
        res.json({
            issuer:
                "https://dev-duromcyrubs02o5n.us.auth0.com/",

            authorization_endpoint:
                "https://dev-duromcyrubs02o5n.us.auth0.com/authorize",

            token_endpoint:
                "https://dev-duromcyrubs02o5n.us.auth0.com/oauth/token",

            response_types_supported: [
                "code"
            ],

            grant_types_supported: [
                "authorization_code"
            ],

            code_challenge_methods_supported: [
                "S256"
            ],

            scopes_supported: [
                "jobs:read",
                "jobs:create"
            ]
        });
    }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MCP server running on port ${PORT}`);
});
