import { JobStoreError } from "./db/jobs.js";

export const toolResult = (value, isError = false) => ({
    isError,
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }]
});

export function toolError(action, error) {
    if (error instanceof JobStoreError) return toolResult(error.message, true);
    // PostgreSQL errors may include connection details or supplied data. Do not return/log them verbatim.
    console.error(`Unable to ${action}:`, error.code ?? error.name);
    return toolResult(`Unable to ${action}. Check job details or search existing jobs before retrying.`, true);
}
