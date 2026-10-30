const corsHeaders = {
  "Access-Control-Allow-Origin": "https://studio-gh.github.io",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Vary": "Origin"
};

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra }
});
const token = (n = 32) => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => b.toString(16).padStart(2, "0")).join("");
const digest = async value => {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(h), b => b.toString(16).padStart(2, "0")).join("");
};
class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const encKey = async secret => crypto.subtle.importKey("raw",
  await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  "AES-GCM", false, ["encrypt", "decrypt"]);
async function encrypt(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encKey(secret), new TextEncoder().encode(value));
  const all = new Uint8Array(iv.length + data.byteLength);
  all.set(iv); all.set(new Uint8Array(data), iv.length);
  return btoa(String.fromCharCode(...all));
}
async function decrypt(value, secret) {
  const all = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, await encKey(secret), all.slice(12));
  return new TextDecoder().decode(plain);
}
function checkOrigin(req, env) {
  const origin = req.headers.get("Origin");
  if (origin && origin !== env.APP_ORIGIN) throw new HttpError(403, "Origin not allowed");
}
function cookie(req, name) {
  const part = (req.headers.get("Cookie") || "").split(";").map(x => x.trim()).find(x => x.startsWith(name + "="));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : null;
}
const clearCookie = "bruma_oauth_state=; Path=/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
function requireConfig(env) {
  for (const key of ["DB", "APP_URL", "APP_ORIGIN", "WORKER_URL", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TOKEN_ENCRYPTION_KEY"]) {
    if (!env[key]) throw new Error("Missing configuration: " + key);
  }
}
function redirect(url, headers = {}) {
  return new Response(null, { status: 302, headers: { Location: url, ...headers } });
}
async function startOAuth(env) {
  const state = token();
  await env.DB.prepare("INSERT INTO oauth_states (state_hash, expires_at) VALUES (?, ?)")
    .bind(await digest(state), new Date(Date.now() + 600000).toISOString()).run();
  const cb = env.WORKER_URL + "/auth/google/callback";
  const u = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  Object.entries({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: cb,
    response_type: "code",
    scope: "openid email profile https://www.googleapis.com/auth/drive.readonly",
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  }).forEach(([k, v]) => u.searchParams.set(k, v));
  return redirect(u.toString(), {
    "Set-Cookie": "bruma_oauth_state=" + encodeURIComponent(state) + "; Path=/auth/google/callback; HttpOnly; Secure; SameSite=Lax; Max-Age=600",
    "Cache-Control": "no-store"
  });
}
async function userFromGoogle(env, profile) {
  await env.DB.prepare(`
    INSERT INTO users (id, google_id, email, name)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(google_id) DO UPDATE SET email = excluded.email, name = excluded.name
  `).bind(token(16), profile.sub, profile.email, profile.name || "").run();
  const user = await env.DB.prepare("SELECT id, email, name FROM users WHERE google_id = ?")
    .bind(profile.sub).first();
  if (!user) throw new HttpError(500, "Could not create user");
  let workspace = await env.DB.prepare("SELECT id FROM workspaces WHERE owner_id = ? ORDER BY created_at LIMIT 1")
    .bind(user.id).first();
  if (!workspace) {
    const id = token(16);
    await env.DB.prepare("INSERT INTO workspaces (id, owner_id, name) VALUES (?, ?, ?)")
      .bind(id, user.id, "Meu workspace").run();
    workspace = { id };
  }
  return { user, workspace };
}
async function saveConnection(env, workspaceId, tokens) {
  const access = await encrypt(tokens.access_token, env.TOKEN_ENCRYPTION_KEY);
  const refresh = tokens.refresh_token ? await encrypt(tokens.refresh_token, env.TOKEN_ENCRYPTION_KEY) : null;
  const expires = new Date(Date.now() + (Number(tokens.expires_in) || 3600) * 1000).toISOString();
  const old = await env.DB.prepare("SELECT id FROM cloud_connections WHERE workspace_id = ? AND provider = 'google_drive' LIMIT 1")
    .bind(workspaceId).first();
  if (old) {
    await env.DB.prepare(`
      UPDATE cloud_connections
      SET access_token_encrypted = ?, refresh_token_encrypted = COALESCE(?, refresh_token_encrypted),
          token_expires_at = ?, updated_at = datetime('now')
      WHERE id = ?
    `).bind(access, refresh, expires, old.id).run();
    return old.id;
  }
  const id = token(16);
  await env.DB.prepare(`
    INSERT INTO cloud_connections (id, workspace_id, provider, access_token_encrypted, refresh_token_encrypted, token_expires_at)
    VALUES (?, ?, 'google_drive', ?, ?, ?)
  `).bind(id, workspaceId, access, refresh, expires).run();
  return id;
}
async function finishOAuth(req, env) {
  const u = new URL(req.url);
  const state = u.searchParams.get("state");
  const code = u.searchParams.get("code");
  if (u.searchParams.has("error")) throw new HttpError(400, "Google authorization cancelled");
  if (!state || !code || cookie(req, "bruma_oauth_state") !== state) throw new HttpError(400, "Invalid OAuth state");
  const hash = await digest(state);
  const saved = await env.DB.prepare("SELECT state_hash FROM oauth_states WHERE state_hash = ? AND expires_at > ?")
    .bind(hash, new Date().toISOString()).first();
  if (!saved) throw new HttpError(400, "Expired OAuth state");
  await env.DB.prepare("DELETE FROM oauth_states WHERE state_hash = ?").bind(hash).run();

  const callback = env.WORKER_URL + "/auth/google/callback";
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: callback, grant_type: "authorization_code"
    })
  });
  const tokens = await response.json();
  if (!response.ok || !tokens.access_token) throw new HttpError(400, "Google token exchange failed");

  const profileResponse = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: { Authorization: "Bearer " + tokens.access_token }
  });
  const profile = await profileResponse.json();
  if (!profileResponse.ok || !profile.sub || !profile.email) throw new HttpError(400, "Could not retrieve Google profile");

  const { user, workspace } = await userFromGoogle(env, profile);
  await saveConnection(env, workspace.id, tokens);

  const oneTime = token();
  await env.DB.prepare("INSERT INTO auth_codes (code_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .bind(await digest(oneTime), user.id, new Date(Date.now() + 300000).toISOString()).run();
  const app = new URL(env.APP_URL);
  app.searchParams.set("bruma_code", oneTime);
  return redirect(app.toString(), { "Set-Cookie": clearCookie, "Referrer-Policy": "no-referrer", "Cache-Control": "no-store" });
}
async function auth(req, env) {
  checkOrigin(req, env);
  const value = req.headers.get("Authorization") || "";
  const bearer = value.startsWith("Bearer ") ? value.slice(7) : "";
  if (!bearer) throw new HttpError(401, "Missing session token");
  const user = await env.DB.prepare(`
    SELECT users.id AS user_id, users.email, users.name
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(await digest(bearer), new Date().toISOString()).first();
  if (!user) throw new HttpError(401, "Invalid or expired session");
  return { user, bearer };
}
async function exchange(req, env) {
  checkOrigin(req, env);
  const body = await req.json().catch(() => ({}));
  if (typeof body.code !== "string" || body.code.length < 40) throw new HttpError(400, "Invalid authorization code");
  const hash = await digest(body.code);
  const found = await env.DB.prepare("SELECT user_id FROM auth_codes WHERE code_hash = ? AND expires_at > ?")
    .bind(hash, new Date().toISOString()).first();
  if (!found) throw new HttpError(401, "Expired or invalid authorization code");
  await env.DB.prepare("DELETE FROM auth_codes WHERE code_hash = ?").bind(hash).run();
  const session = token();
  const expiry = new Date(Date.now() + 7 * 86400000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)")
    .bind(token(16), found.user_id, await digest(session), expiry).run();
  return json({ success: true, token: session, expires_at: expiry });
}
async function driveAccess(env, workspaceId) {
  const conn = await env.DB.prepare(`
    SELECT id, access_token_encrypted, refresh_token_encrypted, token_expires_at
    FROM cloud_connections WHERE workspace_id = ? AND provider = 'google_drive' LIMIT 1
  `).bind(workspaceId).first();
  if (!conn) throw new HttpError(409, "Google Drive is not connected");
  if (conn.access_token_encrypted && Date.parse(conn.token_expires_at || "") > Date.now() + 60000) {
    return { conn, access: await decrypt(conn.access_token_encrypted, env.TOKEN_ENCRYPTION_KEY) };
  }
  if (!conn.refresh_token_encrypted) throw new HttpError(401, "Drive authorization expired. Reconnect Google.");
  const refresh = await decrypt(conn.refresh_token_encrypted, env.TOKEN_ENCRYPTION_KEY);
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refresh, grant_type: "refresh_token"
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new HttpError(401, "Could not refresh Drive authorization. Reconnect Google.");
  await env.DB.prepare("UPDATE cloud_connections SET access_token_encrypted = ?, token_expires_at = ?, updated_at = datetime('now') WHERE id = ?")
    .bind(await encrypt(data.access_token, env.TOKEN_ENCRYPTION_KEY),
      new Date(Date.now() + (Number(data.expires_in) || 3600) * 1000).toISOString(), conn.id).run();
  return { conn, access: data.access_token };
}
async function workspaceFor(env, userId) {
  const w = await env.DB.prepare("SELECT id, name FROM workspaces WHERE owner_id = ? ORDER BY created_at LIMIT 1")
    .bind(userId).first();
  if (!w) throw new HttpError(404, "Workspace not found");
  return w;
}
async function driveJson(access, url) {
  const res = await fetch(url, { headers: { Authorization: "Bearer " + access } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status === 401 ? 401 : 502, body.error?.message || "Google Drive API error");
  return body;
}
async function collectFiles(access, root) {
  const queue = [root], seen = new Set(), files = [];
  const folderType = "application/vnd.google-apps.folder";
  while (queue.length) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    let page = null;
    do {
      const p = new URLSearchParams({
        q: "'" + id.replace(/'/g, "\\'") + "' in parents and trashed = false",
        fields: "nextPageToken,files(id,name,mimeType,thumbnailLink,imageMediaMetadata,size)",
        pageSize: "1000"
      });
      if (page) p.set("pageToken", page);
      const result = await driveJson(access, "https://www.googleapis.com/drive/v3/files?" + p);
      for (const file of result.files || []) {
        if (file.mimeType === folderType) queue.push(file.id);
        else if (typeof file.mimeType === "string" && file.mimeType.startsWith("image/")) files.push(file);
      }
      page = result.nextPageToken || null;
    } while (page);
  }
  return { files, foldersScanned: seen.size };
}
async function sync(req, env, user) {
  const body = await req.json().catch(() => ({}));
  const folder = typeof body.folder_id === "string" ? body.folder_id.trim() : "";
  if (!folder || folder.length > 512) throw new HttpError(400, "Valid folder_id required");
  const workspace = await workspaceFor(env, user.user_id);
  const { conn, access } = await driveAccess(env, workspace.id);
  const { files, foldersScanned } = await collectFiles(access, folder);
  let gallery = await env.DB.prepare("SELECT id FROM galleries WHERE workspace_id = ? AND folder_id = ? LIMIT 1")
    .bind(workspace.id, folder).first();
  if (!gallery) {
    const id = token(16);
    await env.DB.prepare(`
      INSERT INTO galleries (id, workspace_id, cloud_connection_id, title, slug, folder_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(id, workspace.id, conn.id, "Pasta " + folder, "drive-" + (await digest(folder)).slice(0, 12), folder).run();
    gallery = { id };
  } else {
    await env.DB.prepare("UPDATE galleries SET cloud_connection_id = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(conn.id, gallery.id).run();
  }
  for (const file of files) {
    const old = await env.DB.prepare("SELECT id FROM assets WHERE provider_file_id = ? LIMIT 1")
      .bind(file.id).first();
    const values = [
      gallery.id, file.name, file.thumbnailLink || null,
      file.imageMediaMetadata?.width || null, file.imageMediaMetadata?.height || null,
      file.mimeType || null, file.id
    ];
    if (old) {
      // Keep a Drive file in its current gallery only when the same file was already indexed there.
      // The provider_file_id is globally unique in D1, so a sync cannot create duplicate records.
      await env.DB.prepare(`
        UPDATE assets SET gallery_id = ?, filename = ?, thumbnail_url = ?, width = ?, height = ?,
          mime_type = ?, updated_at = datetime('now') WHERE provider_file_id = ?
      `).bind(...values).run();
    } else {
      await env.DB.prepare(`
        INSERT INTO assets (id, gallery_id, provider_file_id, filename, thumbnail_url, width, height, mime_type)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(token(16), gallery.id, file.id, file.name, file.thumbnailLink || null,
        file.imageMediaMetadata?.width || null, file.imageMediaMetadata?.height || null, file.mimeType || null).run();
    }
  }
  return json({
    success: true, gallery_id: gallery.id, folder_id: folder,
    folders_scanned: foldersScanned, files_found: files.length, files_saved: files.length,
    files: files.map(f => ({
      id: f.id, name: f.name, mime_type: f.mimeType || null,
      thumbnail_url: f.thumbnailLink || null,
      width: f.imageMediaMetadata?.width || null,
      height: f.imageMediaMetadata?.height || null
    }))
  });
}
async function listGalleries(env, user) {
  const w = await workspaceFor(env, user.user_id);
  const rows = await env.DB.prepare(`
    SELECT g.id, g.title, g.slug, g.folder_id, g.created_at, g.updated_at, COUNT(a.id) AS asset_count
    FROM galleries g LEFT JOIN assets a ON a.gallery_id = g.id
    WHERE g.workspace_id = ? GROUP BY g.id ORDER BY g.updated_at DESC
  `).bind(w.id).all();
  return json({ workspace: w, galleries: rows.results || [] });
}
async function listAssets(env, user, id) {
  const w = await workspaceFor(env, user.user_id);
  const gallery = await env.DB.prepare("SELECT id FROM galleries WHERE id = ? AND workspace_id = ?")
    .bind(id, w.id).first();
  if (!gallery) throw new HttpError(404, "Gallery not found");
  const rows = await env.DB.prepare(`
    SELECT id, provider_file_id, filename, thumbnail_url, width, height, mime_type, created_at
    FROM assets WHERE gallery_id = ? ORDER BY filename COLLATE NOCASE
  `).bind(id).all();
  return json({ assets: rows.results || [] });
}
async function deleteGallery(env, user, id) {
  const w = await workspaceFor(env, user.user_id);
  const result = await env.DB.prepare("DELETE FROM galleries WHERE id = ? AND workspace_id = ?")
    .bind(id, w.id).run();
  if (!result.meta?.changes) throw new HttpError(404, "Gallery not found");
  return json({ success: true });
}
async function route(req, env) {
  const u = new URL(req.url);
  if (req.method === "OPTIONS") {
    if (req.headers.get("Origin") !== env.APP_ORIGIN) return new Response(null, { status: 403 });
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (u.pathname === "/health" && req.method === "GET") {
    // Public, read-only health check. It verifies the D1 binding without exposing data.
    try {
      const result = await env.DB.prepare("SELECT 1 AS ok").first();
      if (result?.ok !== 1) throw new Error("D1 health query returned an unexpected result");
      return json({ app: "Bruma API", status: "online", database: "connected", version: "d1-v1" });
    } catch (error) {
      console.error("Bruma D1 health check failed:", error);
      return json({ app: "Bruma API", status: "degraded", database: "unavailable" }, 503);
    }
  }
  if (u.pathname === "/auth/google" && req.method === "GET") return startOAuth(env);
  if (u.pathname === "/auth/google/callback" && req.method === "GET") {
    try { return await finishOAuth(req, env); }
    catch (e) { return json({ error: e.message }, e.status || 500, { "Set-Cookie": clearCookie }); }
  }
  if (u.pathname === "/auth/exchange" && req.method === "POST") return exchange(req, env);
  const { user, bearer } = await auth(req, env);
  if (u.pathname === "/auth/me" && req.method === "GET") return json({ user });
  if (u.pathname === "/auth/logout" && req.method === "POST") {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await digest(bearer)).run();
    return json({ success: true });
  }
  if (u.pathname === "/api/galleries" && req.method === "GET") return listGalleries(env, user);
  if (u.pathname === "/api/sync" && req.method === "POST") return sync(req, env, user);
  const assets = u.pathname.match(/^\/api\/galleries\/([^/]+)\/assets$/);
  if (assets && req.method === "GET") return listAssets(env, user, decodeURIComponent(assets[1]));
  const del = u.pathname.match(/^\/api\/galleries\/([^/]+)$/);
  if (del && req.method === "DELETE") return deleteGallery(env, user, decodeURIComponent(del[1]));
  return json({ error: "Not found" }, 404);
}
export default {
  async fetch(req, env) {
    try {
      requireConfig(env);
      return await route(req, env);
    } catch (e) {
      console.error("Bruma API error:", e);
      return json({ error: e.message || "Internal server error" }, e.status || 500);
    }
  }
};
