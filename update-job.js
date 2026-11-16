import { randomUUID } from "node:crypto";
import { z } from "zod";
import { confirmationSchema } from "./create-job.js";
import { updatesSchema } from "./job-schema.js";
import { toolResult, toolError } from "./tool-result.js";

const TTL = 10 * 60 * 1000;

export function registerUpdateJob(server, jobs, subject) {
    let pending;
    async function apply(preview, signal) {
        try {
            signal.throwIfAborted();
            const job = await jobs.update(preview.slug, preview.updates, subject, preview.version);
            return toolResult({ success: true, job });
        } catch (error) {
            return toolError("complete or verify the job update", error);
        }
    }

    server.registerTool("update_job", {
        description: `Prepare changes to a shared demo job using its exact slug from search_jobs or get_job_details.
Send only changed fields. Null clears optional fields; [] clears skills.
A native confirmation dialog is used if supported. Otherwise show the complete returned preview,
ask for approval, and STOP until the user replies before calling confirm_job_update.
Never infer approval from the original request. A new preview replaces the old preview.
If another user edits the job before confirmation, fetch details and prepare a fresh preview.`,
        inputSchema: z.object({
            slug: z.string().trim().min(1).refine(value => value !== "." && value !== ".."),
            updates: updatesSchema
        }).strict(),
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, async ({ slug, updates }, extra) => {
        try {
            extra.signal.throwIfAborted();
            pending = undefined;
            const existing = await jobs.getBySlug(slug);
            if (!existing) return toolResult("Job not found. Search for its exact slug first.", true);
            const preview = { confirmation_id: randomUUID(), slug, updates, version: existing.version, expiresAt: Date.now() + TTL };
            if (!server.server.getClientCapabilities()?.elicitation?.form) {
                pending = preview;
                return toolResult({
                    status: "confirmation_required", confirmation_id: preview.confirmation_id,
                    slug, updates, version: preview.version,
                    message: "No changes have been made. Show the slug and all changes, ask for approval, and STOP until the user replies. Then call confirm_job_update."
                });
            }
            const confirmation = await server.server.elicitInput({
                mode: "form",
                message: `Confirm changes to job "${slug}" (version ${preview.version}):\n${JSON.stringify(updates, null, 2)}`,
                requestedSchema: {
                    type: "object",
                    properties: { confirm: { type: "boolean", title: "Update this job", default: false } },
                    required: ["confirm"]
                }
            }, { relatedRequestId: extra.requestId, signal: extra.signal });
            if (confirmation.action !== "accept" || confirmation.content?.confirm !== true) {
                return toolResult("Job update cancelled. No changes were made.");
            }
            if (Date.now() >= preview.expiresAt) return toolResult("Confirmation expired. Prepare a fresh preview.", true);
            return apply(preview, extra.signal);
        } catch (error) {
            return toolError("prepare the job update", error);
        }
    });

    server.registerTool("confirm_job_update", {
        description: `Confirm or cancel the latest update_job preview only after showing all changes and receiving a subsequent explicit user reply.
Never call automatically. IDs are single-use, session-bound and expire after 10 minutes. Requested edits require a new preview.`,
        inputSchema: confirmationSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    }, async ({ confirmation_id, confirm }, extra) => {
        if (!pending || pending.confirmation_id !== confirmation_id || Date.now() >= pending.expiresAt) {
            return toolResult("No matching pending confirmation exists. Prepare a new preview and obtain fresh approval.", true);
        }
        const preview = pending;
        pending = undefined;
        if (!confirm) return toolResult("Job update cancelled. No changes were made.");
        return apply(preview, extra.signal);
    });
}
