import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Cloudflare deployment never supplies an empty or destructive secrets file", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(workflow, /--secrets-file\b/i);
  assert.doesNotMatch(workflow, /wrangler\s+secret\s+delete\b/i);
  assert.doesNotMatch(workflow, /(?:echo|printf)\s+['"]?\{\s*\}['"]?\s*>[^\n]*secrets/i);
  assert.match(workflow, /wrangler\s+secret\s+bulk\s+\/tmp\/newchat-secrets\.json/);
  assert.match(workflow, /OPENROUTER_API_KEY/);
  assert.match(workflow, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(workflow, /secrets\.NEWCHAT_GITHUB_TOKEN/);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_[A-Z0-9_]+/);
  assert.match(workflow, /secrets\.NEWCHAT_GITHUB_APP_PRIVATE_KEY/);
  assert.match(workflow, /EDENAI_API_KEY/);
  assert.match(workflow, /Required Cloudflare secrets are missing/);
  assert.match(workflow, /npx wrangler deploy --var APP_COMMIT_SHA:\$\{GITHUB_SHA\}/);
});

test("Wrangler configuration does not declare an empty or generated secret set", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

  assert.doesNotMatch(config, /^\s*\[secrets\]\s*$/m);
  assert.doesNotMatch(config, /^\s*required\s*=\s*\[\s*\]\s*$/m);
});
