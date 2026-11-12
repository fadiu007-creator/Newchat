import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const migration = await readFile(new URL("../supabase/migrations/018_mcp_api_tokens.sql", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");

test("remote MCP exposes authenticated autonomous task tools and stores only hashed credentials", () => {
  assert.match(worker, /if \(url\.pathname === "\/mcp"\) return handleMcp/);
  assert.match(worker, /newchat_start_task/);
  assert.match(worker, /newchat_get_task/);
  assert.match(worker, /newchat_cancel_task/);
  assert.match(worker, /token_hash=eq\./);
  assert.match(worker, /sha256Hex\(token\)/);
  assert.match(migration, /enable row level security/);
  assert.match(migration, /revoke all on public\.mcp_api_tokens from anon, authenticated/);
  assert.match(app, /IntegrationsWorkspace/);
  assert.match(app, /Claude on Android/);
  assert.match(app, /ChatGPT/);
});
