import { executeSandbox, executeGithubOperation, sha256Hex, type GithubOperation } from "./tool-adapters";
import { extractProviderText, orderModelFallbacks, orderTasksByDependencies, parseJsonObject } from "./agent-utils";
import { WorkflowEntrypoint, WorkflowStep } from "cloudflare:workers";
import type { WorkflowEvent } from "cloudflare:workers";

type Env = {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  OPENROUTER_API_KEY?: string;
  EDENAI_API_KEY?: string;
  GITHUB_APP_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_SANDBOX_REPOSITORY?: string;
  GITHUB_ALLOWED_REPOSITORIES?: string;
};
type Params = { runId: string; userId: string };
type Task = {
  id: string; task_key: string; title: string; description: string;
  acceptance_criteria: string[]; dependencies: string[]; status: string;
  attempts: number; task_type?: string;
};
type Model = {
  provider: "openrouter" | "edenai"; model_id: string; display_name: string;
  capabilities: string[]; is_free: boolean; priority: number;
};
type Metric = { provider: string; model_id: string; quality_score: number | null; avg_latency_ms: number | null };

function canonicalJson(value: unknown): string {
  const normalize = (input: any): any => {
    if (Array.isArray(input)) return input.map(normalize);
    if (input && typeof input === "object") {
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, normalize(input[key])]));
    }
    return input;
  };
  return JSON.stringify(normalize(value));
}
export class AgentWorkflow extends WorkflowEntrypoint<Env, Params> {
  private async db(path: string, method = "GET", body?: unknown) {
    if (!this.env.SUPABASE_URL || !this.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Agent execution database credentials are not configured.");
    const response = await fetch(`${this.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: this.env.SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${this.env.SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const raw = await response.text();
    if (!response.ok) throw new Error(`Database request failed (${response.status}): ${raw.slice(0, 500)}`);
    return raw ? JSON.parse(raw) as any : null;
  }

  private async event(runId: string, userId: string, eventType: string, message: string, metadata: unknown = {}) {
    await this.db("agent_events", "POST", { run_id: runId, user_id: userId, event_type: eventType, message, metadata });
  }

  private async recordMetric(model: Model, taskType: string, durationMs: number, passed: boolean) {
    const filter = `provider=eq.${encodeURIComponent(model.provider)}&model_id=eq.${encodeURIComponent(model.model_id)}&task_type=eq.${encodeURIComponent(taskType)}&select=*`;
    const rows = await this.db(`model_metrics?${filter}`);
    const old = Array.isArray(rows) ? rows[0] : null;
    const count = Number(old?.sample_count || 0);
    const successes = Number(old?.success_count || 0) + (passed ? 1 : 0);
    const failures = Number(old?.failure_count || 0) + (passed ? 0 : 1);
    const latency = Math.round(((Number(old?.avg_latency_ms || 0) * count) + durationMs) / (count + 1));
    const score = successes / (count + 1);
    const values = {
      provider: model.provider, model_id: model.model_id, task_type: taskType,
      sample_count: count + 1, success_count: successes, failure_count: failures,
      avg_latency_ms: latency, avg_cost_usd: 0, quality_score: score,
      last_sample_at: new Date().toISOString(), updated_at: new Date().toISOString()
    };
    if (old?.id) await this.db(`model_metrics?id=eq.${encodeURIComponent(old.id)}`, "PATCH", values);
    else await this.db("model_metrics", "POST", values);
  }

  private async refreshOpenRouterFreeRegistry(): Promise<{ refreshed: number; available: number; disabled: number }> {
    const response = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { "HTTP-Referer": "https://newchat.shqiptare.workers.dev", "X-Title": "Newchat Agent Registry" }
    });
    if (!response.ok) throw new Error(`OpenRouter model catalogue returned HTTP ${response.status}.`);
    const payload = await response.json() as { data?: Array<{ id?: string; pricing?: { prompt?: string; completion?: string } }> };
    if (!Array.isArray(payload.data)) throw new Error("OpenRouter returned an invalid model catalogue.");
    const availableIds = new Set(payload.data.filter(item => {
      const prompt = Number(item.pricing?.prompt);
      const completion = Number(item.pricing?.completion);
      return typeof item.id === "string" && (item.id.endsWith(":free") || (Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0));
    }).map(item => item.id as string));
    availableIds.add("openrouter/free");
    const rows = await this.db("model_registry?provider=eq.openrouter&is_free=eq.true&select=id,model_id,enabled");
    if (!Array.isArray(rows)) throw new Error("Could not load the saved OpenRouter model registry.");
    let refreshed = 0, disabled = 0;
    const verifiedAt = new Date().toISOString();
    for (const row of rows) {
      const enabled = availableIds.has(row.model_id);
      if (enabled) refreshed++;
      else if (row.enabled) disabled++;
      await this.db(`model_registry?id=eq.${encodeURIComponent(row.id)}`, "PATCH", {
        enabled, last_verified_at: enabled ? verifiedAt : null, updated_at: verifiedAt
      });
    }
    return { refreshed, available: availableIds.size, disabled };
  }

  private async completeTask(task: Task, run: any, userId: string, model: Model, attempt: number, previousFailure = ""): Promise<{ result: any; artifacts: any[]; duration: number; passed: boolean; approval_pending?: boolean }> {
    const started = Date.now();
    const endpoint = model.provider === "openrouter"
      ? "https://openrouter.ai/api/v1/chat/completions"
      : "https://api.edenai.run/v3/chat/completions";
    const key = model.provider === "openrouter" ? this.env.OPENROUTER_API_KEY : this.env.EDENAI_API_KEY;
    if (!key) throw new Error(`${model.provider} is not configured.`);
    const prompt = [
      "You are executing one bounded task inside Newchat. Produce a concrete deliverable, not a plan.",
      "Be explicit about assumptions and limitations. Never claim an external action, deployment, test, or file write happened unless a connected tool actually performed it.",
      "For visual mockup tasks, do not claim an image exists based on a written description. When suitable, create real editable SVG vector files as artifacts (mime_type image/svg+xml, complete <svg>...</svg> content) for each required view. If the request requires raster image generation or animation tools that are unavailable, state that limitation and leave the related criterion unmet.",
      "Return one compact JSON object only, with no markdown fences. Keep the full response below 7,000 output tokens; keep deliverable under 1,200 words and each artifact focused. Schema: {\"deliverable\":\"...\",\"artifacts\":[{\"name\":\"...\",\"mime_type\":\"text/plain\",\"content\":\"...\"}],\"criterion_evidence\":[{\"criterion\":\"...\",\"evidence\":\"...\",\"status\":\"met|not_met|not_verifiable\"}],\"limitations\":[\"...\"],\"execution\":{\"language\":\"javascript|typescript|python\",\"files\":[{\"path\":\"relative/path\",\"content\":\"...\"}],\"argv\":[\"node\",\"--test\"],\"timeout_ms\":60000},\"github_operations\":[{\"action\":\"read_file|list_directory|create_branch|upsert_file|create_pull_request|merge_pull_request|verify_commit\",\"repository\":\"owner/repository\"}]}. Coding tasks must include executable files and a command. For a task that requires visual assets, include actual SVG artifacts with complete valid SVG markup (mime_type image/svg+xml); descriptions of images are not assets. If a requested format cannot be produced, mark its criterion not_met and explain why.",
      "For coding tasks, include complete runnable source files in execution.files and a direct argv command. Supported commands start with node, npm or python3. The GitHub Actions sandbox is an ephemeral container with network disabled and no application secrets. Never claim success unless the returned receipt confirms it. For GitHub writes, propose the exact intended operation; the owner must approve it before execution.",
      "When repository access is needed, return up to four github_operations as an array of exact operation objects. Read operations are read_file {action,repository,path,branch}, list_directory {action,repository,path,branch}, or verify_commit {action,repository,branch}. Write operations are create_branch {action,repository,branch,base,base_sha}, upsert_file {action,repository,path,branch,content,commit_message}, create_pull_request {action,repository,title,body,branch,base}, or merge_pull_request {action,repository,pull_number}. Use only repositories enabled in the user allowlist. Never say a write succeeded before its result is returned.",
      `Goal: ${run.goal}`,
      `Task: ${task.title}`,
      `Description: ${task.description}`,
      `Acceptance criteria: ${JSON.stringify(task.acceptance_criteria)}`,
      `Attempt: ${attempt} of ${run.max_attempts}`,
      `Previous attempt feedback to repair: ${previousFailure || "No previous attempt."}`
    ].join("\n\n");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`, "Content-Type": "application/json",
        ...(model.provider === "openrouter" ? { "HTTP-Referer": "https://newchat.shqiptare.workers.dev", "X-Title": "Newchat Agent" } : {})
      },
      body: JSON.stringify({
        model: model.model_id,
        messages: [
          { role: "system", content: "Return one complete JSON object only. Do not fabricate tool execution. If the requested output cannot be produced with the available tools, state that limitation explicitly." },
          { role: "user", content: prompt }
        ],
        max_tokens: 12000, temperature: 0.1,
        ...(model.provider === "openrouter" ? { reasoning: { effort: "low", exclude: true } } : {})
      })
    });
    const responseText = await response.text();
    let payload: any;
    try { payload = responseText ? JSON.parse(responseText) : {}; }
    catch { throw new Error(`Provider returned a non-JSON response (HTTP ${response.status}): ${responseText.slice(0, 240)}`); }
    if (!response.ok) {
      const detail = typeof payload?.error === "string" ? payload.error : payload?.error?.message;
      throw new Error(detail || `Model request failed (HTTP ${response.status}).`);
    }
    const raw = extractProviderText(payload);
    const result = parseJsonObject<any>(raw);
    if (typeof result.deliverable !== "string" || !result.deliverable.trim() || !Array.isArray(result.criterion_evidence)) {
      throw new Error("Model response must include a non-empty deliverable and criterion evidence.");
    }
    const limitations = Array.isArray(result.limitations) ? result.limitations.filter((x: unknown) => typeof x === "string").slice(0, 20) : [];
    const artifacts = Array.isArray(result.artifacts) ? result.artifacts.filter((x: any) => x && typeof x.name === "string" && typeof x.content === "string").slice(0, 20) : [];
    let execution: any = null;
    if (task.task_type === "coding") {
      if (!result.execution || !Array.isArray(result.execution.files) || !Array.isArray(result.execution.argv)) throw new Error("Coding task did not provide executable files and a bounded command.");
      const language = result.execution.language === "python" || result.execution.argv[0] === "python3"
        ? "python" : result.execution.language === "typescript" || result.execution.files.some((file: any) => String(file.path || "").endsWith(".ts"))
          ? "typescript" : "javascript";
      execution = await executeSandbox(this.env, { language, files: result.execution.files, command: result.execution.argv, timeout_ms: result.execution.timeout_ms }, crypto.randomUUID());
    }

    const githubResults: any[] = [];
    let approvalPending: any = null;
    let githubOperations = Array.isArray(result.github_operations) ? result.github_operations.slice(0, 4) as GithubOperation[] : [];
    const previouslyApproved = await this.db("agent_approvals?run_id=eq." + encodeURIComponent(run.id) + "&task_id=eq." + encodeURIComponent(task.id) + "&user_id=eq." + encodeURIComponent(userId) + "&action_type=eq.github_write&status=eq.approved&consumed_at=is.null&select=id,payload,action_hash&limit=1");
    if (Array.isArray(previouslyApproved) && previouslyApproved[0]?.payload) {
      githubOperations = [previouslyApproved[0].payload as GithubOperation];
    }
    if (githubOperations.length) {
      if (!this.env.GITHUB_APP_TOKEN && !(this.env.GITHUB_APP_ID && this.env.GITHUB_APP_PRIVATE_KEY && this.env.GITHUB_APP_INSTALLATION_ID)) throw new Error("GitHub tools are not configured. Add GitHub App credentials to the Cloudflare Worker.");
      const permissions = await this.db("agent_tool_permissions?user_id=eq." + encodeURIComponent(userId) + "&tool_name=eq.github&enabled=eq.true&select=config");
      const config = Array.isArray(permissions) ? permissions[0]?.config : null;
      const configuredRepos = Array.isArray(config?.repositories) ? config.repositories.filter((value: unknown) => typeof value === "string") : [];
      const globalRepos = (this.env.GITHUB_ALLOWED_REPOSITORIES || "").split(",").map(value => value.trim()).filter(Boolean);
      const allowedRepositories = configuredRepos.filter((value: string) => !globalRepos.length || globalRepos.includes(value));
      if (!allowedRepositories.length) throw new Error("Enable GitHub tools and add at least one allowed repository in the Agent workspace settings.");
      for (const operation of githubOperations) {
        const writeAction = ["create_branch", "upsert_file", "create_pull_request", "merge_pull_request"].includes(operation.action);
        if (writeAction) {
          const actionHash = await sha256Hex(canonicalJson(operation));
          const approved = await this.db("agent_approvals?run_id=eq." + encodeURIComponent(run.id) + "&task_id=eq." + encodeURIComponent(task.id) + "&user_id=eq." + encodeURIComponent(userId) + "&action_type=eq.github_write&action_hash=eq." + actionHash + "&status=eq.approved&consumed_at=is.null&select=id");
          let approval = Array.isArray(approved) ? approved[0] : null;
          if (!approval) {
            const pending = await this.db("agent_approvals?run_id=eq." + encodeURIComponent(run.id) + "&task_id=eq." + encodeURIComponent(task.id) + "&user_id=eq." + encodeURIComponent(userId) + "&action_type=eq.github_write&action_hash=eq." + actionHash + "&status=eq.pending&select=id");
            approval = Array.isArray(pending) ? pending[0] : null;
            if (!approval) {
              const created = await this.db("agent_approvals", "POST", { run_id: run.id, task_id: task.id, user_id: userId, action_type: "github_write", description: "Approve GitHub " + operation.action + " on " + operation.repository, payload: operation, action_hash: actionHash, requested_by: "agent", expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString() });
              approval = Array.isArray(created) ? created[0] : null;
            }
            if (!approval?.id) throw new Error("Could not create a GitHub approval request.");
            approvalPending = { approval_id: approval.id, action: operation.action, repository: operation.repository };
            break;
          }
          const consumed = await this.db("agent_approvals?id=eq." + encodeURIComponent(approval.id) + "&user_id=eq." + encodeURIComponent(userId) + "&status=eq.approved&consumed_at=is.null", "PATCH", { consumed_at: new Date().toISOString() });
          if (!Array.isArray(consumed) || !consumed.length) throw new Error("GitHub approval was already consumed or expired.");
        }
        const operationResult = await executeGithubOperation(this.env, operation, allowedRepositories);
        githubResults.push({ action: operation.action, repository: operation.repository, result: operationResult });
      }
    }
    if (approvalPending) {
      limitations.push("No GitHub write has been executed yet. The exact operation is waiting for owner approval.");
      return {
        result: {
          deliverable: "Waiting for owner approval before GitHub " + approvalPending.action + " on " + approvalPending.repository + ".",
          criterion_evidence: [], limitations, execution, github_results: githubResults,
          approval_pending: approvalPending, model_review_passed: false
        },
        artifacts, duration: Date.now() - started, passed: false, approval_pending: true
      };
    }
    const evidenceByCriterion = new Map(result.criterion_evidence.map((item: any) => [item.criterion, item]));
    const evidenceCorpus = [result.deliverable, ...artifacts.map((artifact: any) => artifact.content)].join("\n");
    const allCriteriaAccountedFor = task.acceptance_criteria.every(c => evidenceByCriterion.has(c));
    // A model's assertion is not evidence: the quoted evidence must occur verbatim in a saved deliverable.
    const modelEvidenceMet = allCriteriaAccountedFor && task.acceptance_criteria.every(c => {
      const item = evidenceByCriterion.get(c) as any;
      return item?.status === "met" && typeof item?.evidence === "string" &&
        item.evidence.trim().length >= 12 && evidenceCorpus.includes(item.evidence.trim());
    });
    const githubVerificationPassed = githubResults.every(item => item.action !== "verify_commit" || item.result?.passed === true);
    const allMet = modelEvidenceMet && (task.task_type !== "coding" || execution?.passed === true) && githubVerificationPassed;
    if (task.task_type === "coding" && execution && !execution.passed) limitations.push(`Sandbox command failed (exit ${execution.exit_code}): ${execution.stderr.slice(0, 1200)}`);
    return {
      result: { deliverable: result.deliverable, criterion_evidence: result.criterion_evidence, limitations, model_review_passed: modelEvidenceMet, execution, github_results: githubResults, external_execution: task.task_type === "coding" ? "github-actions-isolated-runner" : "not_required" },
      artifacts, duration: Date.now() - started, passed: allMet
    };
  }

  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const { runId, userId } = event.payload;
    const run = await step.do("load-agent-run", async () => {
      const rows = await this.db(`agent_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}&select=*`);
      if (!Array.isArray(rows) || !rows[0]) throw new Error("Agent run was not found for this user.");
      return rows[0];
    });
    const start = Date.now();
    try {
    await step.do("mark-run-running", async () => {
      await this.db(`agent_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
        status: "running", started_at: run.started_at || new Date().toISOString(),
        execution_started_at: run.execution_started_at || new Date().toISOString(), heartbeat_at: new Date().toISOString()
      });
      await this.event(runId, userId, "execution_started", "Durable agent execution started.");
      return { started: true };
    });

    const tasks = await step.do("load-agent-tasks", async () => {
      const rows = await this.db(`agent_tasks?run_id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}&select=*&order=position.asc`);
      return orderTasksByDependencies(rows as Task[]);
    });
    await step.do("refresh-openrouter-free-model-registry", async () => {
      try {
        const result = await this.refreshOpenRouterFreeRegistry();
        await this.event(runId, userId, "model_registry_refreshed", `Model registry checked; ${result.refreshed} free OpenRouter models refreshed.`, result);
        return result;
      } catch (error) {
        await this.event(runId, userId, "model_registry_refresh_failed", "Using the last saved model registry because live catalogue refresh failed.", {
          error: error instanceof Error ? error.message : "Unknown catalogue error"
        });
        return { refreshed: 0, fallback: true };
      }
    });
    const models = await step.do("load-model-registry", async () => {
      const rows = await this.db("model_registry?enabled=eq.true&is_free=eq.true&select=provider,model_id,display_name,capabilities,is_free,priority");
      return rows as Model[];
    });
    const metrics = await step.do("load-model-metrics", async () => {
      const rows = await this.db("model_metrics?select=provider,model_id,quality_score,avg_latency_ms");
      return rows as Metric[];
    });
    const freeModels = models.length ? models : [{
      provider: "openrouter" as const, model_id: "openrouter/free", display_name: "OpenRouter Free Router",
      capabilities: ["general","analysis","coding","writing"], is_free: true, priority: 10
    }];
    const metricFor = (m: Model) => metrics.find(x => x.provider === m.provider && x.model_id === m.model_id);
    // All execution candidates are explicitly free. Paid models are intentionally excluded until
    // the approval workflow and real cost accounting are enabled.
    const strategy = run.strategy || "balanced";
    const sortedModels = orderModelFallbacks([...freeModels].sort((a, b) => {
      const am = metricFor(a), bm = metricFor(b);
      const aq = am?.quality_score ?? 0, bq = bm?.quality_score ?? 0;
      const al = am?.avg_latency_ms ?? 120000, bl = bm?.avg_latency_ms ?? 120000;
      if (strategy === "best_quality") return (bq - aq) || a.priority - b.priority;
      if (strategy === "free_first") return Number(b.is_free) - Number(a.is_free) || (bq - aq) || a.priority - b.priority;
      const aScore = aq * 0.75 + (1 / (1 + al / 30000)) * 0.25;
      const bScore = bq * 0.75 + (1 / (1 + bl / 30000)) * 0.25;
      return (bScore - aScore) || a.priority - b.priority;
    }), "general");

    for (const task of tasks) {
      if (task.status === "completed" || task.status === "skipped") continue;
      if (Date.now() - start > run.max_runtime_minutes * 60_000) {
        await this.db(`agent_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", { status: "blocked", last_error: "Maximum runtime reached.", finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });
        await this.event(runId, userId, "runtime_limit", "Run paused because its maximum runtime was reached.");
        return { status: "blocked", reason: "runtime_limit" };
      }
      const dependencies = task.dependencies || [];
      const unmet = tasks.filter(t => dependencies.includes(t.task_key) && t.status !== "completed");
      if (unmet.length) {
        await this.db(`agent_tasks?id=eq.${encodeURIComponent(task.id)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", { status: "blocked", error: "Dependencies are not complete." });
        continue;
      }
      let success = false;
      let lastFailure = "";
      const configuredAttempts = Math.max(1, Math.min(10, Number(run.max_attempts) || 3));
      const boundedAttempts = Math.min(10, Math.max(configuredAttempts, Math.min(sortedModels.length, 6)));
      for (let attempt = Math.max(1, (task.attempts || 0) + 1); attempt <= boundedAttempts && !success; attempt++) {
        const pool = orderModelFallbacks(sortedModels, task.task_type || "general");
        if (!pool.length) throw new Error("No eligible free AI models are configured for this task.");
        const model = pool[(attempt - 1) % pool.length];
        const stepName = `task-${task.id}-attempt-${attempt}`.slice(0, 240);
        const attemptStarted = Date.now();
        let outcome: { passed: boolean; result: any } | null = null;
        try {
          outcome = await step.do(stepName, { retries: { limit: 0 } }, async () => {
          await this.db(`agent_tasks?id=eq.${encodeURIComponent(task.id)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
            status: "running", attempts: attempt, assigned_provider: model.provider, assigned_model: model.model_id,
            verification_status: "running", error: null
          });
          await this.event(runId, userId, "task_started", `Started: ${task.title}`, { task_id: task.id, attempt, provider: model.provider, model: model.model_id });
          const result = await this.completeTask(task, run, userId, model, attempt, lastFailure);
          if (result.approval_pending) {
            await this.db("agent_tasks?id=eq." + encodeURIComponent(task.id) + "&user_id=eq." + encodeURIComponent(userId), "PATCH", { status: "blocked", verification_status: "not_started", result: result.result, error: "Waiting for owner approval before a GitHub write operation." });
            await this.db("agent_runs?id=eq." + encodeURIComponent(runId) + "&user_id=eq." + encodeURIComponent(userId), "PATCH", { status: "blocked", last_error: "A GitHub operation is waiting for owner approval." });
            await this.event(runId, userId, "approval_requested", "A GitHub write operation is waiting for your approval.", result.result.approval_pending);
            return { passed: false, result: result.result, approval_pending: true };
          }
          await this.recordMetric(model, task.task_type || "general", result.duration, result.passed).catch(async error => {
            await this.event(runId, userId, "model_metric_write_failed", "Task result was retained; model telemetry could not be updated.", {
              provider: model.provider, model: model.model_id,
              error: error instanceof Error ? error.message.slice(0, 300) : "Unknown metric write error"
            }).catch(() => undefined);
          });
          await this.db("agent_steps", "POST", {
            run_id: runId, task_id: task.id, user_id: userId, attempt, step_type: attempt > 1 ? "repair" : "model",
            provider: model.provider, model: model.model_id, input_summary: task.title,
            output_summary: result.result.deliverable.slice(0, 3000), status: "completed",
            duration_ms: result.duration, cost_usd: 0, metadata: { free_route: true, execution_receipt: result.result.execution?.receipt_id || null, sandbox_exit_code: result.result.execution?.exit_code ?? null }
          });
          for (const artifact of result.artifacts) {
            await this.db("agent_artifacts", "POST", {
              run_id: runId, task_id: task.id, user_id: userId, name: artifact.name.slice(0, 240),
              mime_type: typeof artifact.mime_type === "string" ? artifact.mime_type.slice(0, 120) : "text/plain",
              content_text: artifact.content, metadata: { provider: model.provider, model: model.model_id }
            });
          }
          await this.db(`agent_tasks?id=eq.${encodeURIComponent(task.id)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
            status: result.passed ? "completed" : (attempt === boundedAttempts ? "failed" : "ready"),
            verification_status: result.passed ? "passed" : (attempt === boundedAttempts ? "needs_review" : "failed"),
            result: result.result, evidence: result.result.criterion_evidence,
            error: result.passed ? null : "One or more acceptance criteria were not evidenced."
          });
          await this.event(runId, userId, result.passed ? "task_completed" : "task_verification_failed",
            result.passed ? `Completed: ${task.title}` : `Acceptance criteria not satisfied: ${task.title}`,
            { task_id: task.id, attempt, artifacts: result.artifacts.length, limitations: result.result.limitations });
          return { passed: result.passed, result: result.result };
          });
        } catch (error) {
          lastFailure = error instanceof Error ? error.message : "Model execution failed.";
          await this.recordMetric(model, task.task_type || "general", Date.now() - attemptStarted, false).catch(() => undefined);
          await this.db(`agent_tasks?id=eq.${encodeURIComponent(task.id)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
            status: attempt === boundedAttempts ? "failed" : "ready",
            verification_status: attempt === boundedAttempts ? "needs_review" : "failed",
            attempts: attempt, assigned_provider: model.provider, assigned_model: model.model_id,
            error: lastFailure.slice(0, 1000)
          }).catch(() => undefined);
          await this.db("agent_steps", "POST", {
            run_id: runId, task_id: task.id, user_id: userId, attempt, step_type: "model",
            provider: model.provider, model: model.model_id, input_summary: task.title,
            output_summary: lastFailure.slice(0, 1000), status: "failed",
            duration_ms: 0, cost_usd: 0, metadata: { fallback_attempt: attempt < boundedAttempts }
          }).catch(() => undefined);
          await this.event(runId, userId, "model_fallback", `Model failed; trying the next eligible free model for: ${task.title}`, {
            task_id: task.id, attempt, provider: model.provider, model: model.model_id, error: lastFailure
          }).catch(() => undefined);
          continue;
        }
        if (!outcome) {
          lastFailure = "Model execution returned no result.";
          continue;
        }
        if ((outcome.result as any)?.approval_pending) return { status: "blocked", reason: "approval_required" };
        success = outcome.passed;
        task.status = success ? "completed" : (attempt === boundedAttempts ? "failed" : "ready");
        if (!success) {
          const evidence = Array.isArray(outcome.result?.criterion_evidence) ? JSON.stringify(outcome.result.criterion_evidence).slice(0, 2400) : "No criterion evidence returned.";
          const limits = Array.isArray(outcome.result?.limitations) ? JSON.stringify(outcome.result.limitations).slice(0, 1000) : "";
          lastFailure = `Acceptance verification failed. Previous evidence: ${evidence}. Limitations: ${limits}`;
        }
      }
      if (!success) {
        await this.db(`agent_tasks?id=eq.${encodeURIComponent(task.id)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
          status: "failed", verification_status: "needs_review", error: (lastFailure || "Task did not produce a verified deliverable.").slice(0, 1000)
        });
        await this.event(runId, userId, "task_failed", `Task failed after bounded model fallbacks: ${task.title}`, { task_id: task.id, error: lastFailure || "No verified deliverable returned." });
      }
    }

    const finalTasks = await step.do("reload-final-task-statuses", async () =>
      await this.db(`agent_tasks?run_id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}&select=status`));
    const allCompleted = Array.isArray(finalTasks) && finalTasks.length > 0 && finalTasks.every((t: any) => t.status === "completed" || t.status === "skipped");
    const terminal = allCompleted ? "completed" : "blocked";
    await step.do("persist-final-run-status", async () => {
      await this.db(`agent_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
        status: terminal, finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString()
      });
      await this.event(runId, userId, terminal, allCompleted
        ? "All task acceptance checks passed. Review the recorded limitations and evidence."
        : "Execution stopped with blocked or failed tasks. Review task evidence and limitations.");
      return { status: terminal };
    });
    return { status: terminal };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected agent workflow failure.";
      await this.db(`agent_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(userId)}`, "PATCH", {
        status: "blocked", last_error: message.slice(0, 1000), finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString()
      }).catch(() => undefined);
      await this.event(runId, userId, "execution_failed", "Agent execution stopped because an unexpected workflow error occurred.", { error: message.slice(0, 1000) }).catch(() => undefined);
      return { status: "blocked", reason: "execution_error", error: message.slice(0, 300) };
    }
  }
}
