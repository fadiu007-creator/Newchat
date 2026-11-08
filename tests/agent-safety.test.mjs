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

const sandboxSource = await readFile(new URL("../worker/sandbox.ts", import.meta.url), "utf8");
const workflowSource = await readFile(new URL("../worker/agent-workflow.ts", import.meta.url), "utf8");

test("Cloudflare Container sandbox runs without outbound internet and uses bounded workspace inputs", async () => {
  assert.match(sandboxSource, /container\.start\(\{ image: container\.images\.workspace, enableInternet: false \}\)/);
  assert.match(await readFile(new URL("../worker/sandbox-validation.ts", import.meta.url), "utf8"), /MAX_FILES = 30/);
  assert.match(await readFile(new URL("../worker/sandbox-validation.ts", import.meta.url), "utf8"), /MAX_TOTAL_BYTES = 1_000_000/);
  assert.match(await readFile(new URL("../worker/sandbox-validation.ts", import.meta.url), "utf8"), /MAX_TIMEOUT_MS = 180_000/);
  assert.match(await readFile(new URL("../worker/sandbox-validation.ts", import.meta.url), "utf8"), /SAFE_PATH/);
  assert.match(sandboxSource, /new Files\(ctx\.container\)/);
});

test("coding tasks require actual Cloudflare sandbox execution and successful exit receipt", () => {
  assert.match(workflowSource, /task\.task_type === "coding"/);
  assert.match(workflowSource, /AGENT_SANDBOX\.getByName/);
  assert.match(workflowSource, /execution\?\.passed === true/);
  assert.match(workflowSource, /sandbox_exit_code/);
});

const { validateSandboxJob } = await import("../worker/sandbox-validation.ts");

test("sandbox validator accepts a bounded, relative workspace job", () => {
  assert.deepEqual(validateSandboxJob({ files: [{ path: "src/main.py", content: "print('ok')" }], argv: ["python3", "src/main.py"], timeout_ms: 5000 }), []);
});

test("sandbox validator rejects traversal, absolute paths, oversized jobs and shell chaining", () => {
  assert.ok(validateSandboxJob({ files: [{ path: "../escape", content: "x" }], argv: ["python3"] }).length > 0);
  assert.ok(validateSandboxJob({ files: [{ path: "/etc/passwd", content: "x" }], argv: ["python3"] }).length > 0);
  assert.ok(validateSandboxJob({ files: [{ path: "main.py", content: "x" }], argv: ["bash", "-c", "echo x; rm -rf /"] }).length > 0);
  assert.ok(validateSandboxJob({ files: [{ path: "main.py", content: "x" }], argv: ["python3"], timeout_ms: 181000 }).length > 0);
  assert.ok(validateSandboxJob({ files: [{ path: "main.py", content: "x".repeat(256001) }], argv: ["python3"] }).length > 0);
});
