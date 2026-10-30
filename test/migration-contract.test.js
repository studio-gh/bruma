import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

const frontend = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const worker = readFileSync(new URL("../worker/index.js", import.meta.url), "utf8");

test("frontend no longer depends on Supabase", () => {
  assert.doesNotMatch(frontend, /supabase|SUPABASE_URL|signInWithOAuth/i);
  assert.match(frontend, /bruma-api\.studio-gh\.workers\.dev/);
});

test("frontend uses the Cloudflare OAuth and session flow", () => {
  assert.match(frontend, /\/auth\/google/);
  assert.match(frontend, /bruma_code/);
  assert.match(frontend, /\/auth\/exchange/);
  assert.match(frontend, /\/auth\/me/);
  assert.match(frontend, /\/auth\/logout/);
});

test("worker exposes the endpoints consumed by the frontend", () => {
  for (const route of [
    "/auth/google",
    "/auth/google/callback",
    "/auth/exchange",
    "/auth/me",
    "/auth/logout",
    "/api/galleries",
    "/api/sync"
  ]) assert.ok(worker.includes('"'+route+'"'), "Missing route: "+route);
});

test("worker health route checks D1 and returns a build marker", () => {
  assert.match(worker, /SELECT 1 AS ok/);
  assert.match(worker, /database: "connected"/);
  assert.match(worker, /build: "bruma-cloudflare-migration-/);
});

test("drive sync only indexes image files and verifies the folder first", () => {
  assert.match(worker, /file\.mimeType\.startsWith\("image\/"\)/);
  assert.match(worker, /folderInfo\.mimeType !== "application\/vnd\.google-apps\.folder"/);
});
