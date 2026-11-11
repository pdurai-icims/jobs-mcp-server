import { randomUUID } from "node:crypto";
import { z } from "zod";

const API_URL = "https://jobs-api-9203.onrender.com/jobs";
const CONFIRMATION_TTL = 10 * 60 * 1000;

const result = (text, isError = false) => ({
    isError,
    content: [{ type: "text", text }]
});

const text = z.string().trim().min(1);

const currency = z.string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/)
    .refine(
        value => Intl.supportedValuesOf("currency").includes(value),
        "Provide a supported ISO 4217 currency code."
    );

function cleanupExpiredPreviews(pendingCreations) {
    const now = Date.now();

    for (const [id, pending] of pendingCreations.entries()) {
        if (now - pending.createdAt > CONFIRMATION_TTL) {
            pendingCreations.delete(id);
        }
    }
}

function creationError(error) {
    console.error("create_job error:", error);
    return result(`Unable to complete or verify job creation. Check existing jobs before retrying to avoid duplicates. Details: ${error.message}`, true);
}

async function createJob(job, signal) {
    try {
        signal?.throwIfAborted();

        const response = await fetch(API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Accept": "application/json"
            },
            body: JSON.stringify(job),
            signal
        });

        if (!response.ok) {
            const details = await response.text();

            console.error(
                "Jobs API create job failed:",
                response.status,
                details
            );

            return result(
                `Unable to create job. Jobs API returned HTTP ${response.status}. ` +
                `Check the job information and existing jobs before retrying.`,
                true
            );
        }

        const data = await response.json();
        const id = data?.job?.id;

        if (
            data?.success === false ||
            !data?.job ||
            typeof data.job !== "object" ||
            Array.isArray(data.job) ||
            !(
                (typeof id === "string" && id.trim()) ||
                (typeof id === "number" && Number.isFinite(id))
            )
        ) {
            throw new Error(
                "Jobs API returned an invalid response or missing job ID."
            );
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

    // Multiple pending previews can exist simultaneously.
    const pendingCreations = new Map();

    // Load configured defaults.
    const defaults = z.object({
        employment_type: text.optional(),
        job_type: text.optional(),
        salary_currency: currency.optional()
    }).parse({
        employment_type: process.env.DEFAULT_EMPLOYMENT_TYPE,
        job_type: process.env.DEFAULT_JOB_TYPE,
        salary_currency: process.env.DEFAULT_SALARY_CURRENCY
    });

    // Job creation input schema.
    const jobSchema = z.object({

        title: text.describe(
            "Required job title. Extract from the user's request. " +
            "Ask the user only if missing."
        ),

        experience: text.describe(
            "Required experience level, such as 3-5 years or Fresher. " +
            "Ask the user only if missing. Ask one question at a time."
        ),

        description: text.optional().describe(
            "Optional job description. If missing, Claude must " +
            "automatically generate a professional description " +
            "based on the job title, experience and relevant skills. " +
            "Never ask the user to write the description."
        ),

        city: text.optional(),
        state: text.optional(),
        country: text.optional(),

        skills: z.array(text).optional(),

        employment_type:
            defaults.employment_type === undefined
                ? text.optional()
                : text.default(defaults.employment_type),

        job_type:
            defaults.job_type === undefined
                ? text.optional()
                : text.default(defaults.job_type),

        industry: text.optional(),

        education_level: text.optional(),

        salary_value: z.number()
            .finite()
            .nonnegative()
            .optional(),

        salary_currency:
            defaults.salary_currency === undefined
                ? currency.optional()
                : currency.default(defaults.salary_currency)

    }).strict();

    // TOOL 1: Prepare job preview.
    server.registerTool(
        "create_job",
        {
            description: `
Prepare a new job posting for user approval.
This tool DOES NOT publish or create the job.

JOB CREATION WORKFLOW:

1. Extract all available job information from the
   user's natural-language request.

2. Mandatory fields:
   - title
   - experience

3. If experience is missing, ask the user for it.
   Ask only one question at a time.
   Do not call this tool until mandatory information
   is available.

4. DESCRIPTION GENERATION:
   If description is missing, automatically generate
   a professional job description using the title,
   experience and relevant skills.
   Do not ask the user whether they want a description.
   Do not ask them to write it.

5. OPTIONAL INFORMATION:
   Extract available information such as:
   - city, state and country
   - skills
   - employment_type
   - job_type
   - industry
   - education_level
   - salary_value
   - salary_currency

   Never ask unnecessarily for optional information.

6. Use configured defaults for employment_type,
   job_type and salary_currency when available.

7. Never invent salary, company information,
   benefits or unsupported requirements.

8. Before calling this tool, ensure a complete
   professional job description is available.
   If missing, generate it first.

9. This tool returns a complete job preview and
   confirmation_id. It never publishes the job.

10. Display the complete preview to the user,
    including all available fields and description.

11. Ask:
    "Would you like to publish this job?"

12. STOP and wait for a subsequent explicit
    user response.

13. If approved, call confirm_job_creation
    with the returned confirmation_id and
    confirm: true.

14. If declined, call confirm_job_creation
    with confirm: false.

15. Never call confirm_job_creation automatically.

16. If the user requests edits, prepare a new
    preview and obtain fresh approval.

Return the complete preview and confirmation ID.
            `,
            inputSchema: jobSchema,
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true
            }
        },

        async (job, extra) => {
            try {
                extra.signal?.throwIfAborted();

                cleanupExpiredPreviews(pendingCreations);

                // Description must exist before preview preparation.
                if (
                    typeof job.description !== "string" ||
                    !job.description.trim()
                ) {
                    return result(JSON.stringify({
                        status: "description_required",
                        message:
                            "No job preview has been created. " +
                            "Generate a professional job description " +
                            "using the available title, experience and skills. " +
                            "Do not ask the user to provide one. " +
                            "Call create_job again with the generated description."
                    }, null, 2), true);
                }

                // Generate unique confirmation ID.
                const confirmation_id = randomUUID();

                // Store the pending job.
                pendingCreations.set(confirmation_id, {
                    job,
                    createdAt: Date.now()
                });

                // Return preview without publishing.
                return result(JSON.stringify({
                    status: "confirmation_required",
                    message:
                        "Job preview prepared successfully. " +
                        "No job has been created. " +
                        "Show the complete job preview and ask the user " +
                        "for explicit approval. Wait for the user's reply " +
                        "before calling confirm_job_creation.",
                    confirmation_id,
                    job
                }, null, 2));

            } catch (error) {
                return creationError(error);
            }
        }
    );
    // TOOL 2: Confirm or cancel job creation.
    server.registerTool(
        "confirm_job_creation",
        {
            description: `
Publish or cancel a previously prepared job preview.

IMPORTANT:
- This tool must only be called after create_job.
- The complete preview must already have been shown.
- The user must explicitly approve or decline it.
- Never infer approval from the original creation request.

PARAMETERS:
- confirmation_id: ID returned by create_job.
- confirm: true to publish, false to cancel.

If confirm is true:
Publish exactly the saved job associated with
the confirmation ID.

If confirm is false:
Cancel the pending job without publishing.

Confirmation IDs are single-use and expire
after 10 minutes.

Never modify job fields during confirmation.
For edits, prepare a new preview and obtain
fresh approval.

Return the job ID and creation status on success.
            `,
            inputSchema: z.object({
                confirmation_id: z.string().uuid(),
                confirm: z.boolean()
            }).strict(),
            annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                idempotentHint: false,
                openWorldHint: true
            }
        },

        async ({ confirmation_id, confirm }, extra) => {
            try {
                extra.signal?.throwIfAborted();

                cleanupExpiredPreviews(pendingCreations);

                const pending = pendingCreations.get(confirmation_id);

                if (!pending) {
                    return result(
                        "No matching pending job preview exists. " +
                        "It may have expired, already been confirmed, " +
                        "or belong to another MCP session. " +
                        "Prepare a new preview before proceeding.",
                        true
                    );
                }

                // Consume the confirmation before any asynchronous API call.
                pendingCreations.delete(confirmation_id);

                if (!confirm) {
                    return result(JSON.stringify({
                        success: false,
                        status: "cancelled",
                        message: "Job creation cancelled. No job was created."
                    }, null, 2));
                }

                // Publish only the exact saved job.
                return await createJob(pending.job, extra.signal);

            } catch (error) {
                return creationError(error);
            }
        }
    );
}