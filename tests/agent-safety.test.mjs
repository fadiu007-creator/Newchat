import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../worker/tool-adapters.ts", import.meta.url), "utf8");

test("sandbox adapter requires HTTPS and authenticated remote runner", () => {
  assert.match(source, /SANDBOX_RUNNER_URL/);
  assert.match(source, /SANDBOX_RUNNER_TOKEN/);
  assert.match(source, /endpoint\.protocol !== "https:"/);
  assert.match(source, /network: "disabled"/);
  assert.match(source, /filesystem: "ephemeral"/);
});

test("sandbox adapter bounds source size, paths, commands and runtime", () => {
  assert.match(source, /MAX_FILES = 30/);
  assert.match(source, /MAX_FILE_BYTES = 256_000/);
  assert.match(source, /MAX_TOTAL_BYTES = 1_000_000/);
  assert.match(source, /timeout < 1000 \|\| timeout > 180000/);
  assert.match(source, /Command must be a bounded argument array/);
});

test("GitHub adapter uses a server secret and restricts repository and API path formats", () => {
  assert.match(source, /GITHUB_APP_TOKEN/);
  assert.match(source, /SAFE_REPO/);
  assert.match(source, /path\.includes\("\.\."\)/);
  assert.match(source, /api\.github\.com/);
});

test("independent GitHub verification requires successful commit statuses and check runs", () => {
  assert.match(source, /verifyGitHubCommit/);
  assert.match(source, /statuses\?\.state === "success"/);
  assert.match(source, /item\.conclusion === "success"/);
  assert.match(source, /checksOk/);
});

test("spend enforcement rejects projected spend above the explicit budget", () => {
  assert.match(source, /enforceSpendBudget/);
  assert.match(source, /projected <= budgetUsd/);
});

test("consequential action classes are centrally identified", () => {
  assert.match(source, /github_write.*deployment.*database_write.*external_message.*purchase.*delete_data.*paid_model/);
});
