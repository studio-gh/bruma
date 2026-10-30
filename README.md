# Bruma

Bruma is a lightweight gallery and Google Drive synchronization interface.

## Architecture

- Frontend: GitHub Pages at https://studio-gh.github.io/bruma/
- API: Cloudflare Worker at https://bruma-api.studio-gh.workers.dev
- Database: Cloudflare D1
- Identity and Drive access: Google OAuth 2.0
- Google access and refresh tokens are encrypted in the Worker using TOKEN_ENCRYPTION_KEY.

## Worker routes

- GET /health
- GET /auth/google
- GET /auth/google/callback
- POST /auth/exchange
- GET /auth/me
- POST /auth/logout
- GET /api/galleries
- GET /api/galleries/:id/assets
- POST /api/sync
- DELETE /api/galleries/:id

## Required Worker variables

Text variables:
- APP_ORIGIN=https://studio-gh.github.io
- APP_URL=https://studio-gh.github.io/bruma/
- WORKER_URL=https://bruma-api.studio-gh.workers.dev

Secrets:
- GOOGLE_CLIENT_ID
- GOOGLE_CLIENT_SECRET
- TOKEN_ENCRYPTION_KEY

D1 binding:
- DB

## Google OAuth configuration

Authorized JavaScript origin:
- https://studio-gh.github.io

Authorized redirect URI:
- https://bruma-api.studio-gh.workers.dev/auth/google/callback

Enable the Google Drive API in the Google Cloud project.

## D1 database

The Worker expects these tables and columns:

- users(id, google_id, email, name, created_at)
- workspaces(id, owner_id, name, created_at)
- oauth_states(state_hash, expires_at, created_at)
- auth_codes(code_hash, user_id, expires_at, created_at)
- sessions(id, user_id, token_hash, expires_at, created_at)
- cloud_connections(id, workspace_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at, created_at, updated_at)
- galleries(id, workspace_id, cloud_connection_id, title, slug, folder_id, created_at, updated_at)
- assets(id, gallery_id, provider_file_id, filename, thumbnail_url, width, height, mime_type, created_at, updated_at)

The existing D1 schema should be checked before any production deployment. Do not apply destructive migrations.

## Deployment safety

Do not deploy until:
1. The actual D1 database ID has been copied into wrangler.jsonc.
2. The existing D1 schema has been checked against the expected columns above.
3. Worker JavaScript syntax and SQL statements have been tested.
4. The frontend is deployed and points to the Worker.
5. OAuth login, session restore/logout and a test Drive folder sync pass.

The repository's migration branch is intended for review before merging into main.


## Manual Worker deployment (current setup)

The Cloudflare Worker is currently edited and deployed manually in the Cloudflare dashboard. The GitHub repository branch does not automatically publish Worker code.

Important distinction:
- "Version saved" means the editor saved a version; it does not prove the new version serves production traffic.
- A deployment row marked "Ready" confirms the version is prepared, but the live response must be checked to confirm the active code.
- The live health endpoint for the revised Worker should return:
  `{"app":"Bruma API","status":"online","database":"connected","version":"d1-v1"}`
- If it returns only `{"app":"Bruma API","status":"online"}`, the serving Worker is still running the previous health handler. Do not proceed to OAuth tests.

### Recommended manual deployment verification
1. In Cloudflare, open Workers & Pages → bruma-api → Edit code.
2. Confirm the editor contains the complete `worker/index.js` from this branch.
3. Save the version, then deploy it to Production.
4. Open `https://bruma-api.studio-gh.workers.dev/health?check=<new-value>` in a fresh tab.
5. Confirm the response contains `database: connected` and `version: d1-v1`.
6. Only then test Google OAuth and Drive sync.

The Cloudflare dashboard currently shows the production D1 binding named `DB` pointing to `bruma-db`, and the required runtime variables/secrets are present. Do not recreate these.


## Health route comparison reference

In the current `worker/index.js` on `migration/cloudflare-api`, the complete `/health` route is at lines 338–348 (1-based). It runs `SELECT 1 AS ok` through the D1 binding and returns `database: connected` and `version: d1-v1`.

When comparing the Cloudflare editor, inspect this exact route (not a guessed line range). The live endpoint previously returned only `{"app":"Bruma API","status":"online"}`, which is the old response shape. This proves the live response handler differs from the source route above, but does not identify whether the editor save was omitted, the deployment used a different editor buffer, or a different deployed script/version was routed.
