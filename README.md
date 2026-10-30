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
