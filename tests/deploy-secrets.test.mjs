import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Cloudflare deployment never supplies or generates a secrets file", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(workflow, /--secrets-file\b/i);
  assert.doesNotMatch(workflow, /wrangler\s+secret\s+(?:delete|bulk)\b/i);
  assert.doesNotMatch(workflow, /(?:echo|printf)\s+['"]?\{\s*\}['"]?\s*>[^\n]*secrets/i);
  assert.match(workflow, /npx wrangler deploy --var APP_COMMIT_SHA:\$\{GITHUB_SHA\}/);
});

test("Wrangler configuration does not declare an empty or generated secret set", async () => {
  const config = await readFile(new URL("../wrangler.toml", import.meta.url), "utf8");

  assert.doesNotMatch(config, /^\s*\[secrets\]\s*$/m);
  assert.doesNotMatch(config, /^\s*required\s*=\s*\[\s*\]\s*$/m);
});
