# Jobs MCP Server

Run `npm start` to serve the authenticated MCP endpoint at `/mcp`.
Run `npm test` for local tests (the Jobs API is mocked; no live jobs are changed).

## Updating jobs

Use `search_jobs` or `get_job_details` to identify the exact job slug, then call
`update_job` with `slug` and an `updates` object containing only changed fields.
For clients with form elicitation support, the server shows the slug and proposed
changes in a native confirmation dialog. It sends `PATCH /jobs/:slug` only when
the user accepts with `confirm: true`. Declining, cancelling, or leaving
confirmation unchecked makes no changes.

For clients without form elicitation (such as the reported Claude.ai connection),
`update_job` instead returns `status: "confirmation_required"`, a
`confirmation_id`, and the exact slug and changes. No update is sent yet.
The assistant must show the preview, ask for approval, and wait for a subsequent
user reply before calling `confirm_job_update` with that ID and `confirm: true`.
Use `confirm: false` to cancel. The initial update request is not approval.

Each confirmation is single-use and bound to the saved changes in that MCP
session; it cannot supply replacement fields or a different slug. A new preview
replaces the previous pending preview. Cancellation, an attempted update
(including API failure), or ending the session invalidates its confirmation.
After an uncertain API failure, check job details before requesting a new preview.
Chat confirmation relies on the assistant honoring the user's reply; unlike a
native dialog, the server cannot independently verify that the user approved.

After deploying this change, reconnect or refresh the Claude.ai connector so it
initializes a new session and discovers `confirm_job_update`.

Editable fields: `title`, `description`, `city`, `state`, `country`, `experience`,
`skills`, `employment_type`, `job_type`, `industry`, `education_level`,
`salary_value`, `salary_currency`, `searchable`, and `applyable`.
Title and description must be non-empty strings. Optional text and salary fields
can be cleared with `null`; skills can be cleared with `[]`. Salary is a finite
number or `null`. Unknown fields and empty updates are rejected.

The MCP endpoint uses in-memory sessions so confirmation responses can reach the
pending tool request. Clients must initialize, retain the returned
`Mcp-Session-Id`, and authenticate every POST, GET, and DELETE request as the same
user. DELETE ends the session. After a server restart, clients must initialize
again. Multi-instance deployments require sticky routing for each session.
