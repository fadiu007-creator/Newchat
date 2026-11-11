import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  validateSandboxRequest,
  enforceSpendBudget,
  classifyConsequentialAction,
  selectLatestCheckRuns,
  isCombinedStatusSatisfied
} from "../worker/tool-adapters.ts";
import { extractProviderText, orderModelFallbacks, orderTasksByDependencies, parseJsonObject, rankModelsForExecution } from "../worker/agent-utils.ts";

const adapters = await readFile(new URL("../worker/tool-adapters.ts", import.meta.url), "utf8");
const workflow = await readFile(new URL("../worker/agent-workflow.ts", import.meta.url), "utf8");
const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
const sandboxWorkflow = await readFile(new URL("../.github/workflows/agent-sandbox.yml", import.meta.url), "utf8");
const sandboxRunner = await readFile(new URL("../scripts/agent-sandbox-runner.mjs", import.meta.url), "utf8");
const paidMigration = await readFile(new URL("../supabase/migrations/014_agent_paid_model_approval_reservation.sql", import.meta.url), "utf8");
const spendMigration = await readFile(new URL("../supabase/migrations/015_agent_chat_spend_without_run_id.sql", import.meta.url), "utf8");
const capMigration = await readFile(new URL("../supabase/migrations/016_agent_paid_model_hard_budget_cap.sql", import.meta.url), "utf8");\nconst edenRegistryMigration = await readFile(new URL("../supabase/migrations/017_agent_edenai_free_execution_models.sql", import.meta.url), "utf8");
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
  assert.ok(sandboxRunner.includes('",dst=/workspace"'), "workspace bind mount must use valid Docker --mount syntax");
  assert.equal(sandboxRunner.includes('",dst=/workspace,rw"'), false, "Docker --mount does not accept the rw field");
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
  assert.match(workflow, /sha256Hex\(canonicalJson\(operation\)\)/);
  assert.match(workflow, /consumed_at=is\.null/);
  assert.match(workflow, /approval_pending/);
  assert.match(worker, /approval\/decision/);
});

test("independent GitHub verification requires a real commit, successful status and completed successful checks", () => {
  assert.match(adapters, /commit\.commit\?\.tree\?\.sha/);
  assert.match(adapters, /item\.conclusion === "success"/);
  assert.match(adapters, /selectLatestCheckRuns/);
  assert.match(adapters, /isCombinedStatusSatisfied/);
  assert.match(adapters, /checksPassed/);
  const selected = selectLatestCheckRuns([
    { id: 10, name: "Cloudflare build", app: { slug: "cloudflare-workers-and-pages" }, status: "completed", conclusion: "failure", started_at: "2026-11-09T00:00:00Z" },
    { id: 11, name: "Cloudflare build", app: { slug: "cloudflare-workers-and-pages" }, status: "completed", conclusion: "success", started_at: "2026-11-09T01:00:00Z" },
    { id: 12, name: "GitHub CI", app: { slug: "github-actions" }, status: "completed", conclusion: "success", started_at: "2026-11-09T00:30:00Z" },
    { id: 13, name: "Newchat sandbox", app: { slug: "github-actions" }, status: "completed", conclusion: "success", started_at: "2026-11-09T02:00:00Z" }
  ]);
  assert.equal(selected.length, 2);
  assert.equal(selected.find(item => item.name === "Cloudflare build").conclusion, "success");
  assert.equal(isCombinedStatusSatisfied({ state: "pending", statuses: [] }, true), true);
  assert.equal(isCombinedStatusSatisfied({ state: "pending", statuses: [{ state: "pending" }] }, true), false);
  assert.equal(isCombinedStatusSatisfied({ state: "success", statuses: [] }, false), true);
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


test("provider response parser handles string and multipart content and reports empty responses", () => {
  assert.equal(extractProviderText({ choices: [{ message: { content: '  {"ok":true}  ' } }] }), '{"ok":true}');
  assert.equal(extractProviderText({ choices: [{ message: { content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] } }] }), "hello world");
  assert.throws(() => extractProviderText({ choices: [{ finish_reason: "length", message: { content: null } }] }), /finish_reason=length/);
});

test("JSON extraction handles code fences, nested braces and escaped quotes", () => {
  const parsed = parseJsonObject('prefix ```json\\n{"text":"a } brace and \\"quote\\"","nested":{"ok":true}}``` suffix');
  assert.equal(parsed.nested.ok, true);
  assert.equal(parsed.text, 'a } brace and "quote"');
  assert.throws(() => parseJsonObject('{"broken":'), /incomplete JSON/);
});

test("agent plans are executed in dependency order even when planner returns tasks backwards", () => {
  const ordered = orderTasksByDependencies([
    { key: "finish", title: "Finish", description: "", acceptance_criteria: ["done"], depends_on: ["build"] },
    { key: "build", title: "Build", description: "", acceptance_criteria: ["built"], depends_on: ["setup"] },
    { key: "setup", title: "Setup", description: "", acceptance_criteria: ["ready"], depends_on: [] }
  ]);
  assert.deepEqual(ordered.map(task => task.key), ["setup", "build", "finish"]);
  const persistedOrder = orderTasksByDependencies([
    { task_key: "child", title: "Child", dependencies: ["parent"] },
    { task_key: "parent", title: "Parent", dependencies: [] }
  ]);
  assert.deepEqual(persistedOrder.map(task => task.task_key), ["parent", "child"]);
  assert.throws(() => orderTasksByDependencies([
    { key: "a", title: "A", description: "", acceptance_criteria: ["a"], depends_on: ["missing"] }
  ]), /unknown dependency/);
  assert.throws(() => orderTasksByDependencies([
    { key: "a", title: "A", description: "", acceptance_criteria: ["a"], depends_on: ["b"] },
    { key: "b", title: "B", description: "", acceptance_criteria: ["b"], depends_on: ["a"] }
  ]), /dependency cycle/);
});

test("agent model ranking prioritizes verified success, then untested models, over failed-only fast models", () => {
  const ranked = rankModelsForExecution([
    { provider: "openrouter", model_id: "fast-but-failed", priority: 1 },
    { provider: "edenai", model_id: "untested", priority: 2 },
    { provider: "edenai", model_id: "proven", priority: 20 }
  ], [
    { provider: "openrouter", model_id: "fast-but-failed", sample_count: 5, success_count: 0, failure_count: 5, quality_score: 0, avg_latency_ms: 1000 },
    { provider: "edenai", model_id: "proven", sample_count: 3, success_count: 3, failure_count: 0, quality_score: 1, avg_latency_ms: 80000 }
  ]);
  assert.deepEqual(ranked.map(model => model.model_id), ["proven", "untested", "fast-but-failed"]);
});

test("verified free Eden AI models are registered for autonomous task execution", () => {
  assert.match(edenRegistryMigration, /google\/gemma-4-31b-it/);
  assert.match(edenRegistryMigration, /google\/gemma-4-26b-a4b-it/);
  assert.match(edenRegistryMigration, /is_free=true/);
  assert.match(workflow, /rankModelsForExecution\(freeModels, metrics, strategy\)/);
});

test("model fallback exhausts task-specialized models before general free models without duplicates", () => {
  const pool = orderModelFallbacks([
    { provider: "openrouter", model_id: "general", capabilities: ["general"] },
    { provider: "openrouter", model_id: "coder", capabilities: ["coding"] },
    { provider: "openrouter", model_id: "coder", capabilities: ["coding"] }
  ], "coding");
  assert.deepEqual(pool.map(model => model.model_id), ["coder", "general"]);
});

test("agent execution contains a real model catalogue refresh and supports retrying blocked tasks", () => {
  assert.match(workflow, /private async refreshOpenRouterFreeRegistry/);
  assert.match(workflow, /extractProviderText\(payload\)/);
  assert.match(workflow, /orderModelFallbacks\(sortedModels, task\.task_type/);
  assert.match(workflow, /orderTasksByDependencies\(rows as Task\[\]\)/);
  assert.match(workflow, /mime_type image\/svg\+xml/);
  assert.match(worker, /orderTasksByDependencies\(tasks\)/);
  assert.match(worker, /select=id,task_key,status,dependencies/);
  assert.match(worker, /attempts: 0, verification_status: "not_started"/);
  assert.match(worker, /\["planned", "blocked", "failed"\]/);
  assert.match(worker, /status=eq\.\$\{encodeURIComponent\(run\.status\)\}/);
  assert.match(worker, /status: ready \? "ready" : "pending"/);
  assert.match(worker, /status=eq\.pending/);
  assert.match(worker, /cost_usd: 0, metadata: \{ reserved: false/);
  assert.match(deployWorkflow, /const requiredConfiguration = \["github", "supabase", "openrouter"\]/);
  assert.doesNotMatch(deployWorkflow, /const requiredConfiguration = .*edenai/);
});

test("agent fallback handles token truncation without duplicate provider retries and persists terminal state", () => {
  assert.match(workflow, /max_tokens: 7000/);\n  assert.match(workflow, /AbortSignal\.timeout\(150_000\)/);
  assert.match(workflow, /reasoning: \{ effort: "low", exclude: true \}/);
  assert.match(workflow, /const boundedAttempts = Math\.min\(pool\.length, Math\.max\(configuredAttempts, Math\.min\(pool\.length, 6\)\)\)/);
  assert.match(workflow, /retries: \{ limit: 0, delay: "1 second", backoff: "constant" \}/);\n  assert.match(workflow, /timeout: "8 minutes"/);
  assert.match(workflow, /status: "blocked", last_error: message\.slice\(0, 1000\), finished_at:/);
  assert.match(workflow, /status: "failed", verification_status: "needs_review"/);
  assert.match(workflow, /actual SVG artifacts with complete valid SVG markup/);
});

test("planner classifies web setup, rendering, animation and app functionality as coding work", () => {
  assert.match(worker, /website\|webpage\|frontend\|backend\|component\|repository\|source code\|script\|function\|render\|rendering\|animation\|functionality\|ui\|ux\|web project/);
  assert.match(worker, /max_tokens: 4000/);
  assert.match(worker, /finish_reason === "length"/);
  assert.match(worker, /editable SVG or HTML\/CSS\/JavaScript artwork/);
});

test("agent status polling reconciles terminal Cloudflare Workflow states into durable run status", () => {
  assert.match(worker, /\["errored", "terminated", "complete"\]/);
  assert.match(worker, /Workflow completed with incomplete or failed tasks/);
  assert.match(worker, /workflow_status_reconciled/);
  assert.match(app, /\/api\/agent\/status\?run_id=/);
  assert.match(app, /workflowResult\?\.run\?\.status \|\| runData\.status/);
  assert.match(app, /\["paused", "blocked", "failed"\]\.includes\(plan\.status\)/);
  assert.match(app, /Retry failed tasks/);
});


test("autonomous runs cannot configure a paid spend budget and the UI does not expose a no-op budget field", () => {
  assert.match(worker, /const budget = 0;/);
  assert.doesNotMatch(worker, /body\.max_budget_usd/);
  assert.doesNotMatch(app, /Maximum spend \(USD\)/);
  assert.match(app, /Autonomous runs use free model routes only/);
});

test("settings opens an account and rolling paid-usage panel; inert chat tools are not rendered", () => {
  assert.match(app, /onClick=\{\(\) => setSettingsOpen\(true\)\}/);
  assert.match(app, /agent_run_spend/);
  assert.match(app, /\$1\.00/);
  assert.doesNotMatch(app, /Attach file \(coming soon\)|Voice \(coming soon\)/);
});
