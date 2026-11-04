import { z } from "zod";

export function registerUpdateJob(server) {
    const optionalText = z.string().trim().nullable().optional();
    const updatesSchema = z.object({
        title: z.string().trim().min(1).optional(),
        description: z.string().trim().min(1).optional(),
        city: optionalText,
        state: optionalText,
        country: optionalText,
        experience: optionalText,
        employment_type: optionalText,
        job_type: optionalText,
        industry: optionalText,
        education_level: optionalText,
        salary_currency: optionalText,
        skills: z.array(z.string()).optional(),
        salary_value: z.number().finite().nullable().optional(),
        searchable: z.boolean().optional(),
        applyable: z.boolean().optional()
    }).strict().refine(
        updates => Object.values(updates).some(value => value !== undefined),
        "Provide at least one field to update."
    );

    server.registerTool("update_job", {
        description: `Update an existing job by its exact slug. Use search_jobs or get_job_details to identify the job first.
Provide only fields the user wants changed. Null clears optional text or salary; an empty skills array clears skills.
The tool shows the slug and proposed changes in an interactive MCP confirmation dialog.
No update is sent unless the user explicitly approves. Clients without form elicitation cannot update jobs.`,
        inputSchema: {
            slug: z.string().trim().min(1).refine(
                slug => slug !== "." && slug !== "..",
                "Provide a job slug, not a path segment."
            ).describe("Exact slug of the job to update."),
            updates: updatesSchema.describe("Only the fields to change; omitted fields remain unchanged.")
        },
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true
        }
    }, async ({ slug, updates }, extra) => {
        const result = (text, isError = false) => ({
            isError,
            content: [{ type: "text", text }]
        });

        if (!server.server.getClientCapabilities()?.elicitation?.form) {
            return result("Job not updated. This client does not support the required MCP confirmation dialog.", true);
        }

        try {
            const confirmation = await server.server.elicitInput({
                mode: "form",
                message: `Confirm changes to job "${slug}". Only these fields will change:\n${JSON.stringify(updates, null, 2)}`,
                requestedSchema: {
                    type: "object",
                    properties: {
                        confirm: {
                            type: "boolean",
                            title: "Update this job",
                            description: "Approve exactly the changes shown above.",
                            default: false
                        }
                    },
                    required: ["confirm"]
                }
            }, { relatedRequestId: extra.requestId, signal: extra.signal });

            if (confirmation.action !== "accept" || confirmation.content?.confirm !== true) {
                return result("Job update cancelled. No changes were made.");
            }
            extra.signal.throwIfAborted();

            const response = await fetch(
                `https://jobs-api-9203.onrender.com/jobs/${encodeURIComponent(slug)}`,
                {
                    method: "PATCH",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify(updates),
                    signal: extra.signal
                }
            );

            if (!response.ok) {
                const details = await response.text();
                console.error("Jobs API update job failed:", response.status, details);
                return result(`Unable to update job. Jobs API returned HTTP ${response.status}. ${details}`, true);
            }

            const data = await response.json();
            if (data?.success !== true || !data.job || typeof data.job !== "object" || Array.isArray(data.job)) {
                throw new Error("Jobs API returned an invalid update response.");
            }
            return result(JSON.stringify({
                success: true,
                message: "Job updated successfully",
                job: data.job
            }, null, 2));
        } catch (error) {
            console.error("update_job error:", error);
            return result(`Unable to complete or verify the job update. Check job details before retrying. Details: ${error.message}`, true);
        }
    });
}
