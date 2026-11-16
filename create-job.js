import { randomUUID } from "node:crypto";
import { z } from "zod";
import { creationSchema } from "./job-schema.js";
import { toolResult, toolError } from "./tool-result.js";

const TTL = 10 * 60 * 1000;

export function registerCreateJob(server, jobs, subject) {
    let pending;
    server.registerTool("create_job", {
        description: `Prepare a job posting for approval. Extract supplied facts first.
Title and experience are required; ask only for missing mandatory information.
If the description is missing, generate it from supplied facts before calling this tool.
Do not invent salary, benefits, company facts or unsupported requirements.
Do not solicit optional fields unless the user wants to provide them.
This tool never publishes a job. Display the ENTIRE returned preview and ask whether to publish.
STOP and wait for a subsequent explicit user reply before calling confirm_job_creation.
For edits, call create_job again: a new preview invalidates the old one.
All authenticated connector users share this demo job board.`,
        inputSchema: creationSchema(),
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async (job, extra) => {
        try {
            extra.signal.throwIfAborted();
            // Even an incomplete replacement must invalidate a stale preview.
            pending = undefined;
            if (!job.description) {
                return toolResult({ status: "description_required", message: "Generate a description using supplied facts and call create_job again. No preview was created. Do not ask the user to write it." }, true);
            }
            pending = { confirmation_id: randomUUID(), job, expiresAt: Date.now() + TTL };
            return toolResult({
                status: "confirmation_required", confirmation_id: pending.confirmation_id, job,
                message: "No job has been created. Show the complete preview, ask for approval, and STOP until the user replies. Then call confirm_job_creation with their decision."
            });
        } catch (error) {
            return toolError("prepare job creation", error);
        }
    });

    server.registerTool("confirm_job_creation", {
        description: `Publish or cancel the latest create_job preview after showing it and receiving explicit user approval or rejection.
Never infer approval from the initial request. Confirmations expire after 10 minutes, are session-bound and single-use.
The saved job cannot be changed during confirmation.`,
        inputSchema: confirmationSchema,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }, async ({ confirmation_id, confirm }, extra) => {
        if (!pending || pending.confirmation_id !== confirmation_id || Date.now() >= pending.expiresAt) {
            return toolResult("No matching pending confirmation exists. Prepare a new preview and obtain fresh approval.", true);
        }
        const { job } = pending;
        pending = undefined; // Consume before any asynchronous write, including failures.
        if (!confirm) return toolResult({ status: "cancelled", message: "Job creation cancelled. No job was created." });
        try {
            extra.signal.throwIfAborted();
            const created = await jobs.create(job, subject);
            return toolResult({ success: true, job_id: created.id, job: created });
        } catch (error) {
            return toolError("complete or verify job creation", error);
        }
    });
}

export const confirmationSchema = z.object({
    confirmation_id: z.string().uuid(),
    confirm: z.boolean().describe("True only after explicit user approval; false to cancel.")
}).strict();
