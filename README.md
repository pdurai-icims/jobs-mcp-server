# Jobs MCP Server

An authenticated **shared demo job board** for Claude connectors. Everyone who
signs in sees the same jobs and can create or update any posting. PostgreSQL
stores jobs; Auth0 identifies participants. The database records the creator and
last editor without exposing Auth0 subject IDs in tool results.

The server now reads and writes PostgreSQL directly. It no longer calls the
separate `jobs-api-9203.onrender.com` service. All six MCP tool names are preserved.

```text
Claude → public HTTPS endpoint → MCP server → PostgreSQL
                                   ↕
                                 Auth0
```

## Run with Docker Compose

Prerequisites: Docker Engine/Desktop with Compose v2, and access to your existing
Auth0 application/API settings. Use Node 24 LTS if running outside Docker.

1. Edit `.env`: set a random `POSTGRES_PASSWORD` and configure `AUTH0_ISSUER`
   and `AUTH0_AUDIENCE` for your Auth0 tenant and Jobs API. Keep the database
   password only in `.env` or your host's secret settings.
   For local health checks, `PUBLIC_BASE_URL=http://localhost:3000` is sufficient.

2. Build and start:

   ```sh
   docker compose up -d --build
   docker compose ps
   curl http://localhost:3000/health/ready
   ```

   Startup applies versioned migrations before accepting traffic. Compose waits
   for PostgreSQL to become healthy. The database has no public/host port; the
   MCP port binds only to your laptop's loopback interface.

3. Add three synthetic demo postings:

   ```sh
   docker compose exec mcp npm run db:seed
   ```

   Seeding is explicit and repeatable. Existing postings, including participant
   edits, are skipped. Starting/rebuilding the app does not reset or seed data.

The `jobs_data` named volume survives container restarts, rebuilds, and normal
`docker compose down`. **`docker compose down -v` deletes the database volume.**
A volume is not a backup. Changing `POSTGRES_PASSWORD` in `.env` does not change
an already-initialized database role's password; update that role first if you
rotate it.

## Share the connector using a free HTTPS tunnel

Claude's remote connector connects from Anthropic's servers, so localhost alone
is not enough. The included optional ngrok service exposes the MCP service with
HTTPS while the database stays private.

1. Get your free ngrok account's authtoken and assigned development domain.
2. Set `NGROK_AUTHTOKEN` in `.env`.
3. Set `PUBLIC_BASE_URL=https://YOUR-ASSIGNED-DOMAIN.ngrok-free.app` (no `/mcp`).
4. Apply the changed environment and start the tunnel:

   ```sh
   docker compose --profile tunnel up -d --build
   docker compose logs tunnel
   ```

5. Complete the Auth0 configuration below, then add the custom connector in
   Claude using `https://YOUR-ASSIGNED-DOMAIN.ngrok-free.app/mcp`.
6. Share that same connector URL and the public OAuth client ID with participants.
   Each participant signs into Auth0 themselves. Use a public OAuth client with
   PKCE for distribution so no client secret is shared. Keep database credentials
   and the ngrok authtoken private.

Keep the laptop, Docker, and network running during the demo. Ngrok free limits
currently include 20,000 HTTP requests and 1 GB outbound transfer per month;
check the [current limits](https://ngrok.com/docs/pricing-limits/free-plan-limits).
There is no separate ngrok login layer in this configuration; the app uses Auth0.
Free Claude accounts currently support one custom connector; see
[Claude's connector requirements](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp).

Do not substitute a Cloudflare **Quick Tunnel** for this setup without changing
and testing the transport: Quick Tunnels do not support SSE, which this server
uses. A separately configured named tunnel is a different deployment option.

## Auth0 and Claude configuration

The MCP service is an OAuth **resource server**. Its protected-resource metadata
points directly to the exact Auth0 issuer, including the trailing slash. Claude
retrieves Auth0's own metadata and uses Auth0's `/authorize` and `/oauth/token`
endpoints. There is no local OAuth proxy or locally advertised authorization
server. This ensures discovery, the authorization response `iss` parameter, and
token issuer all identify the same service.

The previous proxy advertised the tunnel as issuer while returning Auth0-issued
responses. Claude correctly rejected that mismatch. After upgrading, remove and
re-add the connector so it fetches fresh metadata; don't refresh an old login URL.

Required server environment:

- `AUTH0_ISSUER`: your application's tenant, e.g. `https://TENANT.us.auth0.com/`.
- `AUTH0_AUDIENCE`: your custom Jobs API's Identifier, e.g. `https://jobs-mcp-api`.
  Do not use the built-in Auth0 Management API identifier ending in `/api/v2/`.
- `PUBLIC_BASE_URL`: your public HTTPS origin, without `/mcp`.

The MCP server does not need `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, or
`OAUTH_REDIRECT_URIS`. Legacy copies of those settings are ignored. Configure the
OAuth client in Auth0 and Claude instead; configure callback allowlists in Auth0.

### Audience selection for the existing demo API

Claude sends the standard OAuth `resource` parameter, rather than Auth0's
`audience` parameter. For a **dedicated demo tenant** using the existing stable
API identifier `https://jobs-mcp-api`, set **Tenant Settings → General → API
Authorization Settings → Default Audience** to that exact identifier. Keep
**Resource Parameter Compatibility Profile** off for this approach: the public
connector URL and this stable API identifier are different. This default applies
to every authorization request without an explicit audience in that tenant, so
do not use this approach in a tenant serving unrelated applications without
reviewing that impact.

For a tenant shared with other applications, use the standard resource mapping
instead: create an Auth0 API whose Identifier equals the exact public MCP URL
(including `/mcp`), set `AUTH0_AUDIENCE` to that same URL, authorize the OAuth
application for that API, and enable **Tenant Settings → Advanced → Resource
Parameter Compatibility Profile**. Auth0 then treats the requested `resource`
as the API audience. API identifiers cannot be edited after creation.

References: [Auth0 tenant settings](https://auth0.com/docs/get-started/tenant-settings),
[Auth0 MCP resource compatibility](https://support.auth0.com/center/s/article/mcp-audience-error-with-auth0).

### OAuth application and Claude

1. In the same Auth0 tenant, use an application with the Authorization Code grant
   enabled. Enable its login connection so demo participants can sign in.
2. Add `https://claude.ai/api/mcp/auth_callback` to that application's **Allowed
   Callback URLs**. Use the exact callback Claude documents if it changes.
3. In **Applications → APIs → Jobs MCP → Application Access**, grant that
   application **User-Delegated Access**. If the API uses per-app authorization,
   configure this explicitly. This is separate from machine-to-machine access.
4. In Claude, add your connector URL, choose sign-in and **Use your own OAuth
   client**, and enter the application's Client ID.
5. The client authentication must match Auth0's application **Credentials →
   Authentication Method**:
   - **None / public client:** leave the Claude client-secret field empty. Use a
     separate public app (for example a Native application) with PKCE when
     distributing the connector to people outside your organization.
   - **Client Secret (Post or Basic) / confidential client:** enter that client's
     secret in Claude's OAuth configuration. Claude exchanges codes directly
     with Auth0. Keep this confidential configuration within the intended trusted
     deployment; do not distribute its secret to participants.
   - Other methods need a client configuration supported by Claude; do not
     disable issuer verification to work around an unsupported method.
6. If using refresh tokens, enable the Refresh Token grant and offline access
   for the API. The client must request `offline_access`.

The token verifier still checks Auth0 JWKS, exact issuer, audience and RS256 on
every MCP request. A login redirect by itself does not prove the token exchange
or audience selection works; test a complete sign-in followed by `search_jobs`.

## Hosted alternative: Render Docker + Neon Free

For a connector that stays available while your laptop is off, deploy the
`Dockerfile` as a Render Docker web service and configure a Neon PostgreSQL URL.
The local Compose file is not Render's deployment manifest.

Set these on the web service:

```text
DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full
PUBLIC_BASE_URL=https://YOUR-SERVICE.onrender.com
AUTH0_ISSUER=...
AUTH0_AUDIENCE=...
```

Use the provider's connection details and verified TLS. Do not disable certificate
verification. Use the database's direct connection for migrations/imports if its
pooler restricts session or DDL behavior. This app uses a small pool of five
connections. Startup runs migrations; set the hosting health path to `/health/ready`.

Local `compose.yaml` deliberately connects to its `db` service and overrides
`DATABASE_URL`. To use Neon, run the image on your host or run `npm start` locally
with `DATABASE_URL`; do not expect setting that variable to switch local Compose.

For migrations or seed data against a hosted database, run from a trusted machine:

```sh
npm ci
# Set DATABASE_URL in your ignored .env to the intended hosted database first.
npm run db:migrate
npm run db:seed
```

Render Free sleeps when idle and has ephemeral local storage. Neon keeps jobs
outside the app container, but an app restart still invalidates MCP sessions and
pending confirmations. Keep one MCP instance for this demo; horizontal scaling
would require routing each live session to its owning instance.

Check [Render's free limits](https://render.com/docs/free) and
[Neon's free limits](https://neon.com/pricing). Render Free PostgreSQL expires after
30 days; the hosted option above uses Neon instead. Remain on free plans and
within their usage limits.

## Import existing job data

The old Jobs API source/local state is not in this repository. Obtain a complete
JSON export from that application before retiring it, including **every page**
if its list endpoint is paginated. Do not assume the first `/jobs` response
contains all postings. The importer never fetches or mutates the old API.

Accepted formats: an array of jobs, or `{ "jobs": [...] }`. Each record must have
`title`, `description`, and at least one stable `id`, `slug`, or `req_id`.

```sh
# Keep exported data outside the image and Git history.
mkdir -p exports
# Save your source export as exports/jobs.json.
docker compose cp exports/jobs.json mcp:/tmp/jobs-import.json
docker compose exec mcp npm run db:import -- /tmp/jobs-import.json
```

For a database configured through `.env` outside Compose:

```sh
npm run db:import -- exports/jobs.json
```

Import behavior:

- Preserves UUID IDs, slugs, and request IDs. Numeric/non-UUID IDs become a
  separate `legacy_id` and still work with `get_job_details`.
- Gives other records deterministic UUIDs, making repeated imports safe.
- Converts comma-separated skills to arrays; absent experience becomes
  `Not specified`.
- Imports the documented editable fields. Extra source fields and original audit
  timestamps are not copied; imported rows get an import actor and new timestamps.
- Validates all records before writing; database failures roll back the batch.
- Skips rows matching an existing UUID, slug, request ID, or legacy ID. It never
  overwrites existing rows. Review the inserted/skipped counts and resolve source
  identifier collisions before cutover.

Pause writes to the old service for the final export/import, compare source and
import counts and sample records, then switch the connector. Keep the old export
and deployment until you have verified the new board. Changes made to the new
board are not synchronized back to the old API.

## Tools and confirmation behavior

- `search_jobs`: case-insensitive title/description/skills and location search;
  filters before limiting and reports the full match count. `searchable: false`
  removes a job from search, not from direct lookup or editing.
- `get_job_details`: direct lookup by UUID, slug, request ID, or imported legacy ID.
- `create_job`: prepares a preview; requires title and experience. Claude should
  generate a description from supplied facts when one was not supplied. The
  server will request a description before producing a preview.
- `confirm_job_creation`: publishes exactly the saved preview after explicit
  approval, or cancels it. Creation always uses this two-tool chat flow.
- `update_job`: prepares changed fields and captures the current version. Uses a
  native confirmation dialog when supported, otherwise returns a chat preview.
- `confirm_job_update`: confirms/cancels the chat preview. A competing edit causes
  a conflict instead of silently overwriting changes; fetch details and preview again.

Show the full preview and wait for a subsequent explicit user reply before any
chat confirmation. The initial creation/update request is not approval. Chat
approval still depends on the assistant honoring that reply; the server cannot
independently verify a human's chat message.

Each session holds at most one creation and one update preview. Replacing a
preview invalidates its predecessor. Confirmations expire after ten minutes and
are consumed before writing, including on failures. They cannot be used in another
session. After an uncertain write failure, search/check details before retrying.

Optional creation defaults: `DEFAULT_EMPLOYMENT_TYPE`, `DEFAULT_JOB_TYPE`, and
`DEFAULT_SALARY_CURRENCY`. Leave unset when not needed; explicit inputs win.
Currency codes normalize to uppercase. Salaries must be finite and nonnegative.
Optional update fields may be cleared with `null`, and skills with `[]`.

MCP sessions are intentionally in memory and bound to the authenticated user.
Idle sessions are cleaned up after `SESSION_TTL_MS` (default one hour), with at
most `MAX_SESSIONS` (default 250). Server restarts and session expiry require a
new initialization and fresh previews. Persisted jobs remain available.

## Backups

```sh
mkdir -p backups
docker compose exec -T db pg_dump -U jobs -d jobs > backups/jobs.sql
```

Keep a copy outside the Docker host. Restore into an empty database using
`psql -v ON_ERROR_STOP=1 -U jobs -d jobs < backups/jobs.sql` inside the database
container (pipe via `docker compose exec -T db ...` from the host). Verify the
restore before relying on it. Backups contain job data and internal actor IDs.

## Tests

```sh
npm ci
npm test
```

Tests use PGlite (embedded PostgreSQL) for real SQL execution without Docker,
and the MCP SDK client against a local HTTP listener. They cover migrations,
search, shared edits, optimistic concurrency, confirmations, audit fields,
imports, persistence on disk, Auth0 issuer discovery, and the absence of local
OAuth proxy endpoints. They do not
contact Auth0, Render, ngrok, or an existing job board.

For the same SQL/MCP tests against a real PostgreSQL server:

```sh
TEST_DATABASE_URL='postgresql://USER:PASSWORD@HOST/TEST_DATABASE' npm test
```

Use a disposable test database. Each test worker creates a unique schema and
drops that schema afterward; it requires schema-creation permissions. The disk
reopen test always uses PGlite. Live Claude/Auth0 login and the Docker image still
need an end-to-end smoke test on your deployment machine.
