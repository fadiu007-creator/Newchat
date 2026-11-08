import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateSandboxRequest,
  enforceSpendBudget,
  classifyConsequentialAction
} from "../worker/tool-adapters.ts";

const adapters = await readFile(new URL("../worker/tool-adapters.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../worker/agent-workflow.ts", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const sandboxWorkflow = await readFile(new URL("../.github/workflows/agent-sandbox.yml", import.meta.url), "utf8");
const sandboxRunner = await readFile(new URL("../scripts/agent-sandbox-runner.mjs", import.meta.url), "utf8");
const paidMigration = await readFile(new URL("../supabase/migrations/014_agent_paid_model_approval_reservation.sql", import.meta.url), "utf8");
const spendMigration = await readFile(new URL("../supabase/migrations/015_agent_chat_spend_without_run_id.sql", import.meta.url), "utf8");
const capMigration = await readFile(new URL("../supabase/migrations/016_agent_paid_model_hard_budget_cap.sql", import.meta.url), "utf8");
const deployWorkflow = await readFile(new URL("../.github/workflows/deploy-cloudflare.yml", import.meta.url), "utf8");

test("sandbox is dispatched to GitHub Actions and requires an independent check-run receipt", () => {
  assert.match(adapters, /actions\/workflows\/agent-sandbox\.yml\/dispatches/);
  assert.match(adapters, /external_id === requestId/);
  assert.match(adapters, /independent_check_run_id/);
  assert.match(sandboxWorkflow, /workflow_dispatch/);
  assert.match(sandboxWorkflow, /checks: write/);
  assert.match(sandboxWorkflow, /Newchat sandbox/);
});

test("sandbox runner uses an ephemeral network-disabled container with resource limits", () => {
  for (const flag of ["--network", "none", "--cpus=1", "--memory=512m", "--pids-limit=128", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"]) {
    assert.ok(sandboxRunner.includes(flag), "missing sandbox isolation flag: " + flag);
  }
  assert.match(sandboxRunner, /process\.exit/);
  assert.match(sandboxRunner, /timeout_ms/);
  assert.match(sandboxRunner, /chmodSync\(dirname\(target\), 0o777\)/);
  assert.match(sandboxRunner, /chmodSync\(target, 0o666\)/);
  assert.match(sandboxRunner, /resolve\(resultDir, "receipt\.json"\)/);
});

test("sandbox validator accepts a bounded JavaScript job", () => {
  assert.deepEqual(validateSandboxRequest({
    language: "javascript",
    files: [{ path: "src/main.js", content: "console.log('ok')" }],
    command: ["node", "--test"],
    timeout_ms: 5000
  }), []);
});

test("sandbox validator rejects traversal, duplicate paths, oversized source and shell injection", () => {
  assert.ok(validateSandboxRequest({ language: "python", files: [{ path: "../escape.py", content: "x" }], command: ["python3", "x.py"] }).length > 0);
  assert.ok(validateSandboxRequest({ language: "javascript", files: [{ path: "a.js", content: "x" }, { path: "a.js", content: "y" }], command: ["node", "a.js"] }).length > 0);
  assert.ok(validateSandboxRequest({ language: "javascript", files: [{ path: "a.js", content: "x".repeat(16001) }], command: ["node", "a.js"] }).length > 0);
  assert.ok(validateSandboxRequest({ language: "javascript", files: [{ path: "a.js", content: "x" }], command: ["node", "-e", "x; rm -rf /"] }).length > 0);
  assert.ok(validateSandboxRequest({ language: "javascript", files: [{ path: "a.js", content: "x" }], command: ["node", "a.js"], timeout_ms: 181000 }).length > 0);
  assert.deepEqual(validateSandboxRequest({ language: "javascript", files: [{ path: "package.json", content: "{}" }], command: ["npm", "test"] }), []);
});

test("GitHub operations enforce repository allowlists and expose explicit bounded operations", () => {
  assert.match(adapters, /GITHUB_ALLOWED_REPOSITORIES/);
  assert.match(adapters, /RSASSA-PKCS1-v1_5/);
  assert.match(adapters, /GITHUB_APP_INSTALLATION_ID/);
  assert.match(adapters, /allowed\.includes\(repo\)/);
  assert.match(adapters, /read_file.*list_directory.*create_branch.*upsert_file/s);
  assert.match(adapters, /create_pull_request/);
  assert.match(adapters, /merge_pull_request/);
});

test("GitHub writes pause for owner approval and resume only after consuming a matching approval", () => {
  assert.match(workflow, /action_type: "github_write"/);
  assert.match(workflow, /action_hash/);
  assert.match(workflow, /consumed_at=is\.null/);
  assert.match(workflow, /approval_pending/);
  assert.match(worker, /approval\/decision/);
});

test("independent GitHub verification requires a real commit, successful status and completed successful checks", () => {
  assert.match(adapters, /commit\.commit\?\.tree\?\.sha/);
  assert.match(adapters, /statuses\?\.state === "success"/);
  assert.match(adapters, /item\.conclusion === "success"/);
  assert.match(adapters, /checksPassed/);
});

test("paid models require an explicit matching approval and an atomic spend reservation", () => {
  assert.match(worker, /approval_required: true/);
  assert.match(worker, /reserve_paid_model_call/);
  assert.match(worker, /daily_budget_usd: 1/);
  assert.match(paidMigration, /pg_advisory_xact_lock/);
  assert.match(paidMigration, /status = 'approved'/);
  assert.match(paidMigration, /consumed_at is null/);
  assert.match(paidMigration, /v_spent \+ p_estimated_cost > p_daily_budget/);
});

test("budget helper rejects negative and over-budget projected spend", () => {
  assert.deepEqual(enforceSpendBudget({ spentUsd: 0.2, estimatedUsd: 0.3, budgetUsd: 1 }).allowed, true);
  assert.deepEqual(enforceSpendBudget({ spentUsd: 0.8, estimatedUsd: 0.3, budgetUsd: 1 }).allowed, false);
  assert.throws(() => enforceSpendBudget({ spentUsd: -1, estimatedUsd: 0, budgetUsd: 1 }));
});

test("consequential operations are centrally classified", () => {
  for (const action of ["github_write", "deployment", "database_write", "external_message", "purchase", "delete_data", "paid_model"]) {
    assert.equal(classifyConsequentialAction(action), true);
  }
  assert.equal(classifyConsequentialAction("read_file"), false);
});

test("Worker source is complete and exposes the deployed build identity", () => {
  assert.equal(worker.includes("truncated — re-run"), false);
  assert.match(worker, /build_sha: env\.APP_COMMIT_SHA/);
});
