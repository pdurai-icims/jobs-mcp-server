import { randomUUID } from "node:crypto";
import { z } from "zod";

const result = (text, isError = false) => ({
    isError,
    content: [{ type: "text", text }]
});
const text = z.string().trim().min(1);
const currency = z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/)
    .refine(value => Intl.supportedValuesOf("currency").includes(value), "Provide a supported ISO 4217 currency code.");

function creationError(error) {
    console.error("create_job error:", error);
    return result(`Unable to complete or verify job creation. Check existing jobs before retrying to avoid duplicates. Details: ${error.message}`, true);
}

async function createJob(job, signal) {
    try {
        signal.throwIfAborted();
        const response = await fetch("https://jobs-api-9203.onrender.com/jobs", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Accept": "application/json" },
            body: JSON.stringify(job),
            signal
        });
        if (!response.ok) {
            const details = await response.text();
            console.error("Jobs API create job failed:", response.status, details);
            return result(`Unable to create job. Jobs API returned HTTP ${response.status}. ${details} Check existing jobs before retrying to avoid duplicates.`, true);
        }
        const data = await response.json();
        const id = data?.job?.id;
        if (data?.success === false || !data?.job || typeof data.job !== "object" ||
            Array.isArray(data.job) ||
            !(typeof id === "string" && id.trim() || typeof id === "number" && Number.isFinite(id))) {
            throw new Error("Jobs API returned an invalid creation response or missing job ID.");
        }
        return result(JSON.stringify({
            success: true,
            message: "Job created successfully",
            job_id: id,
            job: data.job
        }, null, 2));
    } catch (error) {
        return creationError(error);
    }
}

export function registerCreateJob(server) {
    let pendingCreation;
    const defaults = z.object({
        employment_type: text.optional(),
        job_type: text.optional(),
        salary_currency: currency.optional()
    }).parse({
        employment_type: process.env.DEFAULT_EMPLOYMENT_TYPE,
        job_type: process.env.DEFAULT_JOB_TYPE,
        salary_currency: process.env.DEFAULT_SALARY_CURRENCY
    });
    const jobSchema = z.object({
        title: text.describe("Required job title. Extract from the user's request; ask only if missing."),
        description: text.describe("Required full job description. Ask only if missing."),
        experience: text.describe("Required experience, such as '3 years' or 'No experience required'. Ask only if missing."),
        city: text.optional(),
        state: text.optional(),
        country: text.optional(),
        skills: z.array(text).optional(),
        employment_type: defaults.employment_type === undefined ? text.optional() : text.default(defaults.employment_type),
        job_type: defaults.job_type === undefined ? text.optional() : text.default(defaults.job_type),
        industry: text.optional(),
        education_level: text.optional(),
        salary_value: z.number().finite().nonnegative().optional(),
        salary_currency: defaults.salary_currency === undefined ? currency.optional() : currency.default(defaults.salary_currency)
    }).strict();

    server.registerTool("create_job", {
        description: `Prepare a new job posting in the connected Jobs API.
Extract all available job information from the user's request. Only title, description, and experience are mandatory.
Ask only for missing mandatory information. Do not ask about optional fields unless the user explicitly wants to provide them.
Use configured defaults for employment_type, job_type, and salary_currency when omitted; otherwise leave optional fields absent.
Validate supplied information; do not invent missing required values.
This tool presents the validated job preview in an interactive confirmation dialog before creating anything.
If the client cannot show a dialog, it returns a pending preview and confirmation_id instead.
Show the entire preview including defaults, ask for approval, then STOP and wait for a subsequent user reply.
Only after explicit approval call confirm_job_creation with that ID and confirm: true.
Never treat the initial creation request as approval. Use confirm: false if declined.
For requested edits, call create_job again and obtain fresh approval of the new preview.
Return the created job_id and job details to the user.`,
        inputSchema: jobSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async (job, extra) => {
        try {
            extra.signal.throwIfAborted();
            pendingCreation = undefined;
            if (!server.server.getClientCapabilities()?.elicitation?.form) {
                pendingCreation = { confirmation_id: randomUUID(), job };
                return result(JSON.stringify({
                    status: "confirmation_required",
                    ...pendingCreation,
                    message: "No job has been created. Show the entire job preview, ask for approval, and STOP until the user replies. Only then call confirm_job_creation with this confirmation_id and the user's decision. The original creation request is not confirmation."
                }, null, 2));
            }
            const confirmation = await server.server.elicitInput({
                mode: "form",
                message: `Preview the job to create:\n${JSON.stringify(job, null, 2)}`,
                requestedSchema: {
                    type: "object",
                    properties: {
                        confirm: {
                            type: "boolean",
                            title: "Create this job",
                            description: "Approve exactly the job shown above.",
                            default: false
                        }
                    },
                    required: ["confirm"]
                }
            }, { relatedRequestId: extra.requestId, signal: extra.signal });
            if (confirmation.action !== "accept" || confirmation.content?.confirm !== true) {
                return result("Job creation cancelled. No job was created.");
            }
            return createJob(job, extra.signal);
        } catch (error) {
            return creationError(error);
        }
    });

    server.registerTool("confirm_job_creation", {
        description: `Confirm or cancel the latest pending create_job preview in this MCP session.
Call only after showing the full preview and receiving a subsequent explicit user reply.
Never call automatically after create_job. True approves the saved job; false cancels.
The confirmation_id is single-use and cannot replace job fields. For edits, obtain a new preview and approval.
Return the created job ID and details.`,
        inputSchema: z.object({
            confirmation_id: z.string().uuid(),
            confirm: z.boolean()
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    }, async ({ confirmation_id, confirm }, extra) => {
        if (!pendingCreation || pendingCreation.confirmation_id !== confirmation_id) {
            return result("Job not created. No matching pending confirmation exists in this session. Request a new create_job preview and fresh approval.", true);
        }
        const { job } = pendingCreation;
        // Consume before awaiting the API to prevent duplicate submissions.
        pendingCreation = undefined;
        if (!confirm) {
            return result("Job creation cancelled. No job was created.");
        }
        return createJob(job, extra.signal);
    });
}
