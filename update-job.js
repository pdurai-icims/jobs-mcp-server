import { randomUUID } from "node:crypto";
import { z } from "zod";

const result = (text, isError = false) => ({
    isError,
    content: [{ type: "text", text }]
});

function updateError(error) {
    console.error("update_job error:", error);
    return result(`Unable to complete or verify the job update. Check job details before retrying. Details: ${error.message}`, true);
}

async function applyUpdate(slug, updates, signal) {
    try {
        signal.throwIfAborted();
        const response = await fetch(
            `https://jobs-api-9203.onrender.com/jobs/${encodeURIComponent(slug)}`,
            {
                method: "PATCH",
                headers: {
                    "Content-Type": "application/json",
                    "Accept": "application/json"
                },
                body: JSON.stringify(updates),
                signal
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
        return updateError(error);
    }
}

export function registerUpdateJob(server) {
    let pendingUpdate;
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
If the client cannot show that dialog, the tool returns a pending preview and confirmation_id without updating.
Show the entire preview and ask the user to approve it. STOP and wait for a subsequent user reply.
Only after explicit approval, call confirm_job_update with the confirmation_id and confirm: true.
If the user declines, call confirm_job_update with confirm: false. If changes are requested, call update_job again for a new preview.
Never infer approval from the initial update request. A new preview replaces the previous pending preview in this session.`,
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
        try {
            extra.signal.throwIfAborted();
            pendingUpdate = undefined;
            if (!server.server.getClientCapabilities()?.elicitation?.form) {
                pendingUpdate = { confirmation_id: randomUUID(), slug, updates };
                return result(JSON.stringify({
                    status: "confirmation_required",
                    ...pendingUpdate,
                    message: "No changes have been made. Show the job slug and all proposed changes to the user, ask for approval, and STOP until the user replies. Only then call confirm_job_update with this confirmation_id and the user's decision. Do not treat the original update request as confirmation."
                }, null, 2));
            }

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
            return applyUpdate(slug, updates, extra.signal);
        } catch (error) {
            return updateError(error);
        }
    });

    server.registerTool("confirm_job_update", {
        description: `Confirm or cancel the latest pending update_job preview in this MCP session.
Call this only after showing the exact slug and changes and receiving a subsequent explicit user response.
Use confirm: true only for approval; use false for rejection. Never call automatically after update_job.
The confirmation_id is single-use and cannot change the saved slug or fields.
If the user requests different changes, call update_job again and obtain fresh approval instead.`,
        inputSchema: z.object({
            confirmation_id: z.string().uuid().describe("Confirmation ID from the latest update_job preview."),
            confirm: z.boolean().describe("True only after the user explicitly approves the displayed changes; false to cancel.")
        }).strict(),
        annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: false,
            openWorldHint: true
        }
    }, async ({ confirmation_id, confirm }, extra) => {
        if (!pendingUpdate || pendingUpdate.confirmation_id !== confirmation_id) {
            return result("Job not updated. No matching pending confirmation exists in this session. Request a new update_job preview and fresh approval.", true);
        }

        const { slug, updates } = pendingUpdate;
        // Consume before awaiting the API so duplicate confirmations cannot apply twice.
        pendingUpdate = undefined;
        if (!confirm) {
            return result("Job update cancelled. No changes were made.");
        }
        return applyUpdate(slug, updates, extra.signal);
    });
}
