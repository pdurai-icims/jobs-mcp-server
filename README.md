# Jobs MCP Server

Run `npm start` to serve the authenticated MCP endpoint at `/mcp`.
Run `npm test` for local tests (the Jobs API is mocked; no live jobs are changed).

## Updating jobs

Use `search_jobs` or `get_job_details` to identify the exact job slug, then call
`update_job` with `slug` and an `updates` object containing only changed fields.
The server shows the slug and proposed changes in a form elicitation dialog.
It sends `PATCH /jobs/:slug` only when the user accepts with `confirm: true`.
Declining, cancelling, or leaving confirmation unchecked makes no changes.
Clients without MCP form elicitation support cannot update jobs.

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
