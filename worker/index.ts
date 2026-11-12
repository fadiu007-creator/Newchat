import { AgentWorkflow } from "./agent-workflow";
import { extractProviderText, orderTasksByDependencies, parseJsonObject } from "./agent-utils";
export { AgentWorkflow };

export interface Env {
  ASSETS: Fetcher;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AGENT_WORKFLOW: {
    create(options: { id: string; params: { runId: string; userId: string } }): Promise<{ id: string }>;
    get(id: string): Promise<{ status(): Promise<unknown>; pause(): Promise<void>; resume(): Promise<void>; terminate(): Promise<void> }>;
  };
  OPENROUTER_API_KEY?: string;
  EDENAI_API_KEY?: string;
  GITHUB_APP_TOKEN?: string;
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_SANDBOX_REPOSITORY?: string;
  GITHUB_ALLOWED_REPOSITORIES?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  ALLOWED_ORIGIN?: string;
  APP_COMMIT_SHA?: string;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatRequest = { provider: "openrouter" | "edenai"; model: string; messages: ChatMessage[]; approval_id?: string };
type Strategy = "balanced" | "best_quality" | "free_first";

const json = (data: unknown, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });

async function authenticate(request: Request, env: Env): Promise<{ token: string; userId: string } | Response> {
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  if (!token || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
    return json({ error: "Authentication is required. Configure Supabase and sign in." }, 401);
  }
  try {
    const response = await fetch(`${new URL(env.SUPABASE_URL).origin}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` }
    });
    if (!response.ok) return json({ error: "Your session is invalid or expired. Please sign in again." }, 401);
    const user = await response.json() as { id?: string };
    if (!user.id) return json({ error: "Could not identify the signed-in user." }, 401);
    return { token, userId: user.id };
  } catch {
    return json({ error: "Unable to verify your session. Please try again." }, 502);
  }
}

function isResponse(value: unknown): value is Response {
  return value instanceof Response;
}

async function supabaseRequest(env: Env, token: string, path: string, method: string, body?: unknown) {
  const response = await fetch(`${env.SUPABASE_URL!.replace(/\/$/, "")}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await response.text();
  let data: unknown = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { ok: response.ok, status: response.status, data };
}

async function supabaseServiceRequest(env: Env, path: string, method: string, body?: unknown) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Server-side Supabase credentials are not configured.");
  const response = await fetch(`${env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await response.text();
  let data: any = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  return { ok: response.ok, status: response.status, data };
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function estimateOpenRouterCost(model: string, messages: ChatMessage[], maxTokens: number) {
  const response = await fetch("https://openrouter.ai/api/v1/models");
  if (!response.ok) throw new Error("Could not retrieve current OpenRouter model pricing.");
  const catalogue = await response.json() as any;
  const entry = (catalogue.data || []).find((item: any) => item.id === model);
  const inputRate = Number(entry?.pricing?.prompt);
  const outputRate = Number(entry?.pricing?.completion);
  if (!entry || !Number.isFinite(inputRate) || !Number.isFinite(outputRate) || inputRate < 0 || outputRate < 0) {
    throw new Error("Current per-token pricing is unavailable for this paid model; the request was blocked.");
  }
  const promptTokens = Math.max(1, messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).byteLength, 0));
  const estimate = Math.max(0.000001, (promptTokens * inputRate + maxTokens * outputRate) * 1.25);
  return { estimatedUsd: Math.ceil(estimate * 100000000) / 100000000, promptTokens, inputRate, outputRate };
}

async function decideAgentApproval(request: Request, env: Env, origin: string) {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
  let body: { approval_id?: string; decision?: "approved" | "rejected"; note?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: "Invalid JSON body." }, 400, origin); }
  const id = body.approval_id || "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || !["approved", "rejected"].includes(body.decision || "")) {
    return json({ error: "A valid approval_id and decision are required." }, 400, origin);
  }
  const found = await supabaseRequest(env, auth.token, `agent_approvals?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(auth.userId)}&select=id,run_id,task_id,action_type,status,expires_at`, "GET");
  if (!found.ok || !Array.isArray(found.data) || !found.data[0]) return json({ error: "Approval request not found." }, 404, origin);
  const approval = found.data[0] as any;
  if (approval.status !== "pending" || (approval.expires_at && Date.parse(approval.expires_at) <= Date.now())) return json({ error: "This approval is no longer pending or has expired." }, 409, origin);
  if (approval.run_id && approval.action_type !== "paid_model" && !env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Agent execution is not configured." }, 503, origin);
  const changed = await supabaseRequest(env, auth.token,
    `agent_approvals?id=eq.${encodeURIComponent(id)}&user_id=eq.${encodeURIComponent(auth.userId)}&status=eq.pending`,
    "PATCH", { status: body.decision, decided_at: new Date().toISOString(), decision_note: (body.note || "").slice(0, 500) });
  if (!changed.ok || !Array.isArray(changed.data) || !changed.data.length) return json({ error: "Approval decision could not be saved." }, 409, origin);
  if (body.decision === "rejected" && approval.run_id && approval.action_type !== "paid_model") {
    if (approval.task_id) await supabaseServiceRequest(env, "agent_tasks?id=eq." + encodeURIComponent(approval.task_id) + "&user_id=eq." + encodeURIComponent(auth.userId), "PATCH", {
      status: "failed", verification_status: "needs_review", error: "Owner rejected the requested GitHub operation."
    });
    await supabaseServiceRequest(env, "agent_runs?id=eq." + encodeURIComponent(approval.run_id) + "&user_id=eq." + encodeURIComponent(auth.userId), "PATCH", {
      status: "failed", last_error: "Owner rejected a required GitHub operation.", finished_at: new Date().toISOString()
    });
    await supabaseServiceRequest(env, "agent_events", "POST", {
      run_id: approval.run_id, user_id: auth.userId, event_type: "approval_rejected",
      message: "Owner rejected a requested GitHub operation; the run was stopped.", metadata: { approval_id: id }
    });
  }
  if (body.decision === "approved" && approval.run_id && approval.action_type !== "paid_model") {
    if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Agent execution is not configured." }, 503, origin);
    try {
      const workflowId = `agent-${approval.run_id}-${crypto.randomUUID()}`;
      const instance = await env.AGENT_WORKFLOW.create({ id: workflowId, params: { runId: approval.run_id, userId: auth.userId } });
      const runUpdate = await supabaseServiceRequest(env, `agent_runs?id=eq.${encodeURIComponent(approval.run_id)}&user_id=eq.${encodeURIComponent(auth.userId)}`, "PATCH", {
        status: "queued", workflow_instance_id: instance.id, last_error: null, paused_at: null
      });
      if (!runUpdate.ok) {
        await (await env.AGENT_WORKFLOW.get(instance.id)).terminate();
        throw new Error("Approval was saved but the agent run could not be resumed.");
      }
      await supabaseServiceRequest(env, "agent_events", "POST", {
        run_id: approval.run_id, user_id: auth.userId, event_type: "approval_granted",
        message: "Owner approved a consequential GitHub operation. Execution resumed.",
        metadata: { approval_id: id }
      });
    } catch (error) {
      await supabaseRequest(env, auth.token, "agent_approvals?id=eq." + encodeURIComponent(id) + "&user_id=eq." + encodeURIComponent(auth.userId) + "&status=eq.approved", "PATCH", {
        status: "pending", decided_at: null, decision_note: "Workflow restart failed; approval is available again."
      });
      return json({ error: error instanceof Error ? error.message : "Could not resume the approved agent run. The approval was reset so it can be retried." }, 502, origin);
    }
  }
  return json({ approval_id: id, status: body.decision }, 200, origin);
}


async function startAgentExecution(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Durable agent execution is not configured: add SUPABASE_SERVICE_ROLE_KEY as a Worker secret." }, 503, origin);
  let body: { run_id?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: "Invalid JSON body." }, 400, origin); }
  const runId = typeof body.run_id === "string" ? body.run_id : "";
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ error: "A valid run_id is required." }, 400, origin);
  const found = await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(runId)}&select=id,status,workflow_instance_id`, "GET");
  if (!found.ok || !Array.isArray(found.data) || !found.data[0]) return json({ error: "Agent run not found." }, 404, origin);
  const run = found.data[0] as { id: string; status: string; workflow_instance_id?: string };
  if (!["planned", "blocked", "failed"].includes(run.status)) {
    return json({ error: `Run cannot be started from status ${run.status}. Use pause/resume for an active workflow.`, status: run.status }, 409, origin);
  }
  const pendingApprovals = await supabaseRequest(env, auth.token,
    `agent_approvals?run_id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}&status=eq.pending&select=id&limit=1`, "GET");
  if (!pendingApprovals.ok) return json({ error: "Could not verify pending owner approvals before restarting this run." }, 502, origin);
  if (Array.isArray(pendingApprovals.data) && pendingApprovals.data.length) {
    return json({ error: "This run is waiting for an owner approval. Approve or reject that request before restarting." }, 409, origin);
  }
  try {
    const taskResult = await supabaseRequest(env, auth.token,
      `agent_tasks?run_id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}&select=id,task_key,status,dependencies`, "GET");
    if (!taskResult.ok || !Array.isArray(taskResult.data) || !taskResult.data.length) {
      return json({ error: "This run has no readable tasks and cannot be restarted." }, 409, origin);
    }
    const tasks = taskResult.data as Array<{ id: string; task_key: string; status: string; dependencies?: string[] }>;
    const claim = await supabaseRequest(env, auth.token,
      `agent_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}&status=eq.${encodeURIComponent(run.status)}`,
      "PATCH", { status: "queued", last_error: null, heartbeat_at: new Date().toISOString() });
    if (!claim.ok || !Array.isArray(claim.data) || !claim.data.length) {
      return json({ error: "This run was started by another request or its status changed. Refresh the agent workspace." }, 409, origin);
    }
    for (const task of tasks) {
      if (task.status === "completed" || task.status === "skipped") continue;
      const dependencyKeys = Array.isArray(task.dependencies) ? task.dependencies : [];
      const ready = tasks.filter(candidate => dependencyKeys.includes(candidate.task_key))
        .every(dependency => dependency.status === "completed" || dependency.status === "skipped");
      const reset = await supabaseRequest(env, auth.token,
        `agent_tasks?id=eq.${encodeURIComponent(task.id)}&user_id=eq.${encodeURIComponent(auth.userId)}`, "PATCH", {
          status: ready ? "ready" : "pending", attempts: 0, verification_status: "not_started",
          error: null, result: null, evidence: []
        });
      if (!reset.ok) throw new Error("Could not reset an incomplete task for retry.");
    }
    const instance = await env.AGENT_WORKFLOW.create({ id: `agent-${run.id}-${crypto.randomUUID()}`, params: { runId: run.id, userId: auth.userId } });
    const runUpdate = await supabaseRequest(env, auth.token,
      `agent_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}`, "PATCH", {
        status: "queued", workflow_instance_id: instance.id, last_error: null, finished_at: null,
        heartbeat_at: new Date().toISOString()
      });
    if (!runUpdate.ok) {
      await (await env.AGENT_WORKFLOW.get(instance.id)).terminate().catch(() => undefined);
      throw new Error("Workflow was created but the run status could not be saved.");
    }
    await supabaseRequest(env, auth.token, "agent_events", "POST", {
      run_id: run.id, user_id: auth.userId, event_type: "execution_queued",
      message: "Durable execution queued. Incomplete tasks were reset for a bounded retry."
    });
    return json({ run_id: run.id, workflow_id: instance.id, status: "queued", retried_tasks: tasks.filter(task => task.status !== "completed" && task.status !== "skipped").length }, 202, origin);
  } catch (error) {
    await supabaseRequest(env, auth.token,
      `agent_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}&status=eq.queued`,
      "PATCH", { status: run.status, last_error: error instanceof Error ? error.message.slice(0, 1000) : "Workflow start failed." }).catch(() => undefined);
    return json({ error: error instanceof Error ? error.message : "Could not start durable execution." }, 502, origin);
  }
}

async function controlAgentExecution(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
  let body: { run_id?: string; action?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: "Invalid JSON body." }, 400, origin); }
  const runId = typeof body.run_id === "string" ? body.run_id : "";
  const action = body.action;
  if (!/^[0-9a-f-]{36}$/i.test(runId) || !["pause", "resume", "cancel"].includes(action || "")) return json({ error: "A valid run_id and action (pause, resume, cancel) are required." }, 400, origin);
  const found = await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(runId)}&select=id,status,workflow_instance_id`, "GET");
  if (!found.ok || !Array.isArray(found.data) || !found.data[0]) return json({ error: "Agent run not found." }, 404, origin);
  const run = found.data[0] as { id: string; status: string; workflow_instance_id?: string };
  if (!run.workflow_instance_id) return json({ error: "This run has no active Workflow instance." }, 409, origin);
  try {
    const instance = await env.AGENT_WORKFLOW.get(run.workflow_instance_id);
    if (action === "pause") {
      await instance.pause();
      const saved = await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}`, "PATCH", { status: "paused", paused_at: new Date().toISOString() });
      if (!saved.ok) throw new Error("Workflow paused, but the run status could not be saved.");
    } else if (action === "resume") {
      await instance.resume();
      const saved = await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}`, "PATCH", { status: "queued", paused_at: null });
      if (!saved.ok) throw new Error("Workflow resumed, but the run status could not be saved.");
    } else {
      await instance.terminate();
      const saved = await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}&user_id=eq.${encodeURIComponent(auth.userId)}`, "PATCH", { status: "cancelled", finished_at: new Date().toISOString(), cancel_requested_at: new Date().toISOString() });
      if (!saved.ok) throw new Error("Workflow terminated, but the cancellation status could not be saved.");
    }
    await supabaseRequest(env, auth.token, "agent_events", "POST", { run_id: run.id, user_id: auth.userId, event_type: `execution_${action}d`, message: `Execution ${action} requested by the owner.` });
    return json({ run_id: run.id, status: action === "pause" ? "paused" : action === "resume" ? "queued" : "cancelled" }, 200, origin);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Could not control Workflow instance." }, 502, origin);
  }
}

async function getAgentExecutionStatus(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
  const runId = new URL(request.url).searchParams.get("run_id") || "";
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return json({ error: "A valid run_id is required." }, 400, origin);
  const result = await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(runId)}&select=id,status,workflow_instance_id,total_cost_usd,last_error,updated_at`, "GET");
  if (!result.ok || !Array.isArray(result.data) || !result.data[0]) return json({ error: "Agent run not found." }, 404, origin);
  const run = result.data[0] as { workflow_instance_id?: string; [key: string]: unknown };
  let workflow: { status?: string; error?: { name?: string; message?: string } } | null = null;
  if (run.workflow_instance_id) {
    try {
      workflow = await (await env.AGENT_WORKFLOW.get(run.workflow_instance_id)).status() as typeof workflow;
      const terminalStatus = workflow?.status;
      if (["errored", "terminated", "complete"].includes(terminalStatus || "") && ["queued", "running", "paused"].includes(String(result.data[0].status))) {
        let reconciledStatus: string;
        let lastError: string | null = null;
        if (terminalStatus === "errored") {
          reconciledStatus = "failed";
          lastError = workflow?.error?.message || workflow?.error?.name || "Cloudflare Workflow terminated with an error.";
        } else if (terminalStatus === "terminated") {
          reconciledStatus = "cancelled";
        } else {
          const taskResult = await supabaseRequest(env, auth.token,
            `agent_tasks?run_id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(auth.userId)}&select=status`, "GET");
          if (!taskResult.ok || !Array.isArray(taskResult.data)) {
            reconciledStatus = "failed";
            lastError = "Workflow completed but task statuses could not be verified.";
          } else {
            reconciledStatus = taskResult.data.length > 0 && taskResult.data.every((task: any) => task.status === "completed" || task.status === "skipped")
              ? "completed" : "blocked";
            if (reconciledStatus === "blocked") lastError = "Workflow completed with incomplete or failed tasks. Retry the incomplete tasks.";
          }
        }
        const saved = await supabaseRequest(env, auth.token,
          `agent_runs?id=eq.${encodeURIComponent(runId)}&user_id=eq.${encodeURIComponent(auth.userId)}&status=in.(queued,running,paused)`,
          "PATCH", { status: reconciledStatus, last_error: lastError, finished_at: new Date().toISOString(), heartbeat_at: new Date().toISOString() });
        if (saved.ok && Array.isArray(saved.data) && saved.data.length) {
          result.data[0].status = reconciledStatus;
          result.data[0].last_error = lastError;
          result.data[0].finished_at = new Date().toISOString();
          await supabaseRequest(env, auth.token, "agent_events", "POST", {
            run_id: runId, user_id: auth.userId, event_type: "workflow_status_reconciled",
            message: `Workflow ended (${terminalStatus}); saved run status was reconciled to ${reconciledStatus}.`,
            metadata: { workflow_status: terminalStatus, run_status: reconciledStatus, error: lastError }
          }).catch(() => undefined);
        }
      }
    } catch { workflow = { status: "unavailable" }; }
  }
  return json({ run: result.data[0], workflow }, 200, origin);
}

function classifyTask(task: { title: string; description: string }): string {
  const text = `${task.title} ${task.description}`.toLowerCase();
  if (/\b(code|coding|implement|build|develop|program|api|database|schema|test|debug|deploy|software|app|website|webpage|frontend|backend|component|repository|source code|script|function|render|rendering|animation|functionality|ui|ux|web project)\b/.test(text)) return "coding";
  if (/\b(research|investigate|compare|sources|fact.?check|findings|market|competitor)\b/.test(text)) return "analysis";
  if (/\b(write|draft|document|proposal|email|content|copy|article|guide|report)\b/.test(text)) return "writing";
  if (/\b(analy[sz]e|review|evaluate|audit|strategy|plan|architecture)\b/.test(text)) return "analysis";
  return "general";
}

function parsePlan(raw: string): { summary: string; success_criteria: string[]; tasks: Array<{ key: string; title: string; description: string; acceptance_criteria: string[]; depends_on: string[] }> } | null {
  try {
    const parsed = parseJsonObject<Record<string, unknown>>(raw);
    if (typeof parsed.summary !== "string" || !Array.isArray(parsed.tasks)) return null;
    const tasks = parsed.tasks.slice(0, 10).map((item, index) => {
      const task = item as Record<string, unknown>;
      const key = typeof task.key === "string" ? task.key.slice(0, 40) : `task-${index + 1}`;
      return {
        key,
        title: typeof task.title === "string" ? task.title.slice(0, 160) : `Task ${index + 1}`,
        description: typeof task.description === "string" ? task.description.slice(0, 4000) : "",
        acceptance_criteria: Array.isArray(task.acceptance_criteria)
          ? task.acceptance_criteria.filter((v): v is string => typeof v === "string").slice(0, 8).map(v => v.slice(0, 500))
          : [],
        depends_on: Array.isArray(task.depends_on)
          ? task.depends_on.filter((v): v is string => typeof v === "string").slice(0, 10)
          : []
      };
    });
    const keys = new Set(tasks.map(t => t.key));
    if (tasks.length < 1 || keys.size !== tasks.length || tasks.some(t => !t.title || t.acceptance_criteria.length === 0 || t.depends_on.some(d => !keys.has(d) || d === t.key))) return null;
    const byKey = new Map(tasks.map(task => [task.key, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();
    const hasCycle = (key: string): boolean => {
      if (visiting.has(key)) return true;
      if (visited.has(key)) return false;
      visiting.add(key);
      for (const dependency of byKey.get(key)?.depends_on || []) if (hasCycle(dependency)) return true;
      visiting.delete(key);
      visited.add(key);
      return false;
    };
    if (tasks.some(task => hasCycle(task.key))) return null;
    const criteria = Array.isArray(parsed.success_criteria)
      ? parsed.success_criteria.filter((v): v is string => typeof v === "string").slice(0, 12).map(v => v.slice(0, 500))
      : [];
    if (!criteria.length) return null;
    return { summary: parsed.summary.slice(0, 2000), success_criteria: criteria, tasks: orderTasksByDependencies(tasks) };
  } catch {
    return null;
  }
}

async function createAgentPlan(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);

  let body: { goal?: string; strategy?: Strategy; max_runtime_minutes?: number; max_attempts?: number };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "Invalid JSON body." }, 400, origin); }

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const strategy = body.strategy || "balanced";
  // Autonomous execution is restricted to free model routes; never accept a configurable paid budget here.
  const budget = 0;
  const runtime = body.max_runtime_minutes ?? 30;
  const attempts = body.max_attempts ?? 3;
  if (goal.length < 3 || goal.length > 12000) return json({ error: "Goal must contain 3–12,000 characters." }, 400, origin);
  if (!["balanced", "best_quality", "free_first"].includes(strategy)) return json({ error: "Invalid model strategy." }, 400, origin);
  if (!Number.isInteger(runtime) || runtime < 1 || runtime > 1440) return json({ error: "Runtime must be between 1 and 1,440 minutes." }, 400, origin);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) return json({ error: "Attempts must be between 1 and 10." }, 400, origin);
  if (!env.OPENROUTER_API_KEY) return json({ error: "OpenRouter is not configured on the Worker." }, 503, origin);

  const started = Date.now();
  const system = [
    "You are the planning component of Newchat, an autonomous goal-execution agent.",
    "Turn the user's goal into a realistic, ordered, dependency-aware plan.",
    "Do not claim to execute actions. Plan only. Include measurable acceptance criteria for every task and measurable overall success criteria.",
    "Keep the plan focused: 2 to 8 tasks for normal goals, up to 10 only when necessary. Tasks should be independently verifiable.",
    "For a requested app, website, or software build, create implementation-first coding tasks with runnable files, real integration steps, and executable tests. Do not substitute a design document or proposal for the requested working product.",
    "Order tasks by their dependencies. Acceptance criteria must describe observable outputs or test results, not model self-assertions.",
    "Never promise raster image, video, audio, deployment, or external service outputs unless the corresponding connected tool is available. For visual web deliverables, plan editable SVG or HTML/CSS/JavaScript artwork when suitable; do not describe text as a generated image.",
    "Classify web project setup, rendering, animation, frontend components, and application functionality as implementation work with runnable source files and tests.",
    "Keep the plan compact: concise task descriptions and no redundant design-only tasks when the user requested a working application.",
    "Return ONLY valid JSON with this exact shape:",
    '{"summary":"...","success_criteria":["..."],"tasks":[{"key":"stable-kebab-key","title":"...","description":"...","acceptance_criteria":["..."],"depends_on":[]}]}',
    "Each depends_on entry must reference another task key in this plan. Do not create circular dependencies."
  ].join("\n");
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://newchat.shqiptare.workers.dev",
        "X-Title": "Newchat Autonomous Planner"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [{ role: "system", content: system }, { role: "user", content: goal }],
        max_tokens: 4000,
        temperature: 0.15,
        reasoning: { effort: "low", exclude: true }
      })
    });
    const responseText = await upstream.text();
    let result: any;
    try { result = responseText ? JSON.parse(responseText) : {}; }
    catch { return json({ error: `Planner provider returned a non-JSON response (HTTP ${upstream.status}).` }, 502, origin); }
    if (!upstream.ok) {
      const detail = typeof result.error === "string" ? result.error : result.error?.message;
      return json({ error: detail || `Planner provider failed (HTTP ${upstream.status}).` }, 502, origin);
    }
    if (result?.choices?.[0]?.finish_reason === "length") {
      return json({ error: "Planner response was truncated by the selected model. Retry with a shorter goal or another free model." }, 502, origin);
    }
    let text: string;
    try { text = extractProviderText(result); }
    catch (error) { return json({ error: error instanceof Error ? error.message : "Planner returned an empty response." }, 502, origin); }
    const plan = parsePlan(text);
    if (!plan) return json({ error: "The planner response could not be validated. Please retry the goal." }, 502, origin);

    const runInsert = await supabaseRequest(env, auth.token, "agent_runs", "POST", {
      user_id: auth.userId, goal, summary: plan.summary, status: "planned",
      strategy, success_criteria: plan.success_criteria,
      max_budget_usd: budget, max_runtime_minutes: runtime, max_attempts: attempts
    });
    if (!runInsert.ok || !Array.isArray(runInsert.data) || !runInsert.data[0]?.id) {
      return json({ error: "Could not save this agent run. Apply migration 003_autonomous_agent.sql to the existing Supabase project.", detail: runInsert.data }, 500, origin);
    }
    const run = runInsert.data[0] as { id: string };
    const taskRows = plan.tasks.map((task, index) => ({
      run_id: run.id, user_id: auth.userId, task_key: task.key, position: index + 1,
      title: task.title, description: task.description,
      acceptance_criteria: task.acceptance_criteria, dependencies: task.depends_on,
      status: task.depends_on.length ? "pending" : "ready",
      task_type: classifyTask(task),
      assigned_provider: "openrouter", assigned_model: "openrouter/free"
    }));
    const taskInsert = await supabaseRequest(env, auth.token, "agent_tasks", "POST", taskRows);
    if (!taskInsert.ok) {
      await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}`, "DELETE");
      return json({ error: "The plan was generated but its tasks could not be saved.", detail: taskInsert.data }, 500, origin);
    }
    const planningDuration = Date.now() - started;
    await Promise.all([
      supabaseRequest(env, auth.token, "agent_events", "POST", {
        run_id: run.id, user_id: auth.userId, event_type: "plan_created",
        message: "Plan created and saved. Execution has not started.",
        metadata: { planner: "openrouter/free", task_count: taskRows.length, planning_duration_ms: planningDuration }
      }),
      supabaseRequest(env, auth.token, "agent_steps", "POST", {
        run_id: run.id, user_id: auth.userId, attempt: 1, step_type: "plan",
        provider: "openrouter", model: "openrouter/free",
        input_summary: goal.slice(0, 1000), output_summary: plan.summary,
        status: "completed", duration_ms: planningDuration, cost_usd: 0,
        metadata: { task_count: taskRows.length, strategy }
      })
    ]);
    return json({
      run_id: run.id, status: "planned", summary: plan.summary,
      success_criteria: plan.success_criteria, tasks: Array.isArray(taskInsert.data) ? taskInsert.data : taskRows,
      planner: { provider: "openrouter", model: "openrouter/free", cost_policy: "free-route-requested" },
      next: "Review the plan, then start execution. Coding tasks use the isolated GitHub Actions runner; repository writes require owner approval."
    }, 201, origin);
  } catch {
    return json({ error: "Unable to create the agent plan. Check provider connectivity and retry." }, 502, origin);
  }
}


async function manageMcpToken(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "MCP token storage is not configured." }, 503, origin);
  const filter = "user_id=eq." + encodeURIComponent(auth.userId) + "&revoked_at=is.null";
  if (request.method === "GET") {
    const rows = await supabaseServiceRequest(env, "mcp_api_tokens?" + filter + "&select=id,label,created_at,last_used_at&order=created_at.desc", "GET");
    if (!rows.ok) return json({ error: "Could not load MCP connection status." }, 502, origin);
    return json({ tokens: rows.data || [] }, 200, origin);
  }
  if (request.method === "DELETE") {
    const revoked = await supabaseServiceRequest(env, "mcp_api_tokens?" + filter, "PATCH", { revoked_at: new Date().toISOString() });
    return revoked.ok ? json({ revoked: true }, 200, origin) : json({ error: "Could not revoke MCP access." }, 502, origin);
  }
  if (request.method !== "POST") return json({ error: "Method not allowed." }, 405, origin);
  let body: any = {};
  try { body = await request.json(); } catch { return json({ error: "Invalid JSON body." }, 400, origin); }
  const label = typeof body.label === "string" ? body.label.trim().slice(0, 80) : "Personal MCP connection";
  const token = "nchat_" + Array.from(crypto.getRandomValues(new Uint8Array(32)), b => b.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha256Hex(token);
  const now = new Date().toISOString();
  const revoked = await supabaseServiceRequest(env, "mcp_api_tokens?" + filter, "PATCH", { revoked_at: now });
  if (!revoked.ok) return json({ error: "Could not rotate the previous MCP credential." }, 502, origin);
  const saved = await supabaseServiceRequest(env, "mcp_api_tokens", "POST", { user_id: auth.userId, token_hash: tokenHash, label, created_at: now });
  if (!saved.ok) return json({ error: "Could not save the MCP credential. Apply migration 018_mcp_api_tokens.sql." }, 500, origin);
  return json({ token, endpoint: new URL("/mcp", request.url).toString(), warning: "Copy this token now. It will not be shown again." }, 201, origin);
}

async function authenticateMcp(request: Request, env: Env): Promise<{ userId: string } | Response> {
  const bearer = request.headers.get("Authorization") || "";
  const token = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
  if (!/^nchat_[a-f0-9]{64}$/.test(token)) return json({ error: "A valid Newchat MCP bearer token is required." }, 401);
  if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "MCP authentication is not configured." }, 503);
  const tokenHash = await sha256Hex(token);
  const found = await supabaseServiceRequest(env, "mcp_api_tokens?token_hash=eq." + tokenHash + "&revoked_at=is.null&select=id,user_id&limit=1", "GET");
  if (!found.ok || !Array.isArray(found.data) || !found.data[0]?.user_id) return json({ error: "MCP token is invalid or revoked." }, 401);
  const row = found.data[0] as { id: string; user_id: string };
  await supabaseServiceRequest(env, "mcp_api_tokens?id=eq." + encodeURIComponent(row.id), "PATCH", { last_used_at: new Date().toISOString() }).catch(() => undefined);
  return { userId: row.user_id };
}

function mcpResult(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, result }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "MCP-Protocol-Version": "2025-03-26" }
  });
}
function mcpError(id: unknown, code: number, message: string) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }), {
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "MCP-Protocol-Version": "2025-03-26" }
  });
}

async function createMcpAgentRun(env: Env, userId: string, goal: string) {
  if (!env.OPENROUTER_API_KEY || !env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("Autonomous execution is not configured on this Worker.");
  if (goal.length < 3 || goal.length > 12000) throw new Error("Goal must contain 3–12,000 characters.");
  const system = [
    "You are Newchat's autonomous task planner. Create a realistic dependency-aware plan of 1–8 tasks.",
    "Every task needs observable acceptance criteria. Coding tasks require runnable source files and executable tests, not just a proposal.",
    'Return ONLY JSON: {"summary":"...","success_criteria":["..."],"tasks":[{"key":"stable-key","title":"...","description":"...","acceptance_criteria":["..."],"depends_on":[]}]}',
    "Dependencies must reference task keys in this plan. Do not claim execution."
  ].join("\n");
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: "Bearer " + env.OPENROUTER_API_KEY, "Content-Type": "application/json", "HTTP-Referer": "https://newchat.shqiptare.workers.dev", "X-Title": "Newchat MCP Agent" },
    body: JSON.stringify({ model: "openrouter/free", messages: [{ role: "system", content: system }, { role: "user", content: goal }], max_tokens: 4000, temperature: 0.1, reasoning: { effort: "low", exclude: true } }),
    signal: AbortSignal.timeout(90000)
  });
  const raw = await upstream.text();
  let payload: any;
  try { payload = raw ? JSON.parse(raw) : {}; } catch { throw new Error("Planner returned an invalid response."); }
  if (!upstream.ok) throw new Error(payload?.error?.message || payload?.error || "Planner failed (HTTP " + upstream.status + ").");
  if (payload?.choices?.[0]?.finish_reason === "length") throw new Error("Planner response was truncated; retry with a shorter goal.");
  const plan = parsePlan(extractProviderText(payload));
  if (!plan) throw new Error("Planner returned a plan that failed validation.");
  const runInsert = await supabaseServiceRequest(env, "agent_runs", "POST", {
    user_id: userId, goal, summary: plan.summary, status: "planned", strategy: "balanced",
    success_criteria: plan.success_criteria, max_budget_usd: 0, max_runtime_minutes: 30, max_attempts: 3
  });
  if (!runInsert.ok || !Array.isArray(runInsert.data) || !runInsert.data[0]?.id) throw new Error("Could not save the agent run.");
  const runId = String(runInsert.data[0].id);
  const taskRows = plan.tasks.map((task, index) => ({
    run_id: runId, user_id: userId, task_key: task.key, position: index + 1, title: task.title,
    description: task.description, acceptance_criteria: task.acceptance_criteria, dependencies: task.depends_on,
    status: task.depends_on.length ? "pending" : "ready", task_type: classifyTask(task),
    assigned_provider: "openrouter", assigned_model: "openrouter/free"
  }));
  const tasks = await supabaseServiceRequest(env, "agent_tasks", "POST", taskRows);
  if (!tasks.ok) {
    await supabaseServiceRequest(env, "agent_runs?id=eq." + encodeURIComponent(runId), "DELETE");
    throw new Error("Could not save the agent tasks.");
  }
  await supabaseServiceRequest(env, "agent_events", "POST", {
    run_id: runId, user_id: userId, event_type: "plan_created",
    message: "Plan created through remote MCP. Autonomous execution will start immediately.",
    metadata: { planner: "openrouter/free", task_count: taskRows.length, source: "mcp" }
  });
  const instance = await env.AGENT_WORKFLOW.create({ id: "agent-" + runId + "-" + crypto.randomUUID(), params: { runId, userId } });
  const started = await supabaseServiceRequest(env, "agent_runs?id=eq." + encodeURIComponent(runId) + "&user_id=eq." + encodeURIComponent(userId), "PATCH", {
    status: "queued", workflow_instance_id: instance.id, heartbeat_at: new Date().toISOString()
  });
  if (!started.ok) {
    await (await env.AGENT_WORKFLOW.get(instance.id)).terminate().catch(() => undefined);
    throw new Error("The plan was saved, but the autonomous Workflow could not be started.");
  }
  await supabaseServiceRequest(env, "agent_events", "POST", {
    run_id: runId, user_id: userId, event_type: "execution_queued",
    message: "Remote MCP started the durable autonomous Workflow.",
    metadata: { workflow_id: instance.id, source: "mcp" }
  });
  return { run_id: runId, workflow_id: instance.id, status: "queued", summary: plan.summary, tasks: tasks.data || taskRows };
}

async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method === "GET") return new Response("Newchat MCP endpoint. Send Streamable HTTP JSON-RPC requests using POST.", { headers: { "Content-Type": "text/plain" } });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const auth = await authenticateMcp(request, env);
  if (auth instanceof Response) return auth;
  let body: any;
  try { body = await request.json(); } catch { return mcpError(null, -32700, "Parse error"); }
  const id = body?.id;
  if (body?.jsonrpc !== "2.0" || typeof body?.method !== "string") return mcpError(id, -32600, "Invalid Request");
  if (body.method === "notifications/initialized" || body.method === "notifications/cancelled") return new Response(null, { status: 202 });
  if (body.method === "ping") return mcpResult(id, {});
  if (body.method === "initialize") return mcpResult(id, {
    protocolVersion: "2025-03-26", capabilities: { tools: {} },
    serverInfo: { name: "newchat-agent", version: "1.0.0" },
    instructions: "Use newchat_start_task to plan and immediately start a bounded autonomous task. Use newchat_get_task to inspect verified results. Coding work runs in an isolated GitHub Actions sandbox. Repository writes require owner approval in Newchat."
  });
  if (body.method === "tools/list") return mcpResult(id, { tools: [
    { name: "newchat_start_task", description: "Create a plan and immediately start autonomous execution in Newchat. Use only for tasks the user explicitly asks you to carry out. Free models only; coding tasks run in an isolated sandbox; repository writes pause for owner approval.", inputSchema: { type: "object", properties: { goal: { type: "string", minLength: 3, maxLength: 12000 } }, required: ["goal"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } },
    { name: "newchat_get_task", description: "Read the status, task results, execution evidence, approvals and generated artifacts for one of the authenticated user's Newchat runs.", inputSchema: { type: "object", properties: { run_id: { type: "string", format: "uuid" } }, required: ["run_id"], additionalProperties: false }, annotations: { readOnlyHint: true, openWorldHint: false } },
    { name: "newchat_cancel_task", description: "Stop a running Newchat autonomous task owned by the authenticated user.", inputSchema: { type: "object", properties: { run_id: { type: "string", format: "uuid" } }, required: ["run_id"], additionalProperties: false }, annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false } }
  ] });
  if (body.method !== "tools/call") return mcpError(id, -32601, "Method not found");
  const name = body?.params?.name;
  const args = body?.params?.arguments || {};
  try {
    if (name === "newchat_start_task") {
      if (typeof args.goal !== "string") throw new Error("goal is required.");
      const started = await createMcpAgentRun(env, auth.userId, args.goal.trim());
      return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(started, null, 2) }], structuredContent: started, isError: false });
    }
    if (name === "newchat_get_task") {
      if (typeof args.run_id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.run_id)) throw new Error("A valid run_id is required.");
      const runId = encodeURIComponent(args.run_id);
      const uid = encodeURIComponent(auth.userId);
      const [run, tasks, approvals, artifacts, events] = await Promise.all([
        supabaseServiceRequest(env, "agent_runs?id=eq." + runId + "&user_id=eq." + uid + "&select=id,goal,summary,status,last_error,total_cost_usd,created_at,finished_at", "GET"),
        supabaseServiceRequest(env, "agent_tasks?run_id=eq." + runId + "&user_id=eq." + uid + "&select=id,title,status,verification_status,error,result,assigned_provider,assigned_model&order=position.asc", "GET"),
        supabaseServiceRequest(env, "agent_approvals?run_id=eq." + runId + "&user_id=eq." + uid + "&select=id,action_type,status,description,payload,created_at", "GET"),
        supabaseServiceRequest(env, "agent_artifacts?run_id=eq." + runId + "&user_id=eq." + uid + "&select=id,name,mime_type,content_text,created_at", "GET"),
        supabaseServiceRequest(env, "agent_events?run_id=eq." + runId + "&user_id=eq." + uid + "&select=event_type,message,created_at&order=created_at.desc&limit=30", "GET")
      ]);
      if (!run.ok || !Array.isArray(run.data) || !run.data[0]) throw new Error("Agent run not found.");
      const result = { run: run.data[0], tasks: tasks.data || [], approvals: approvals.data || [], artifacts: artifacts.data || [], events: events.data || [] };
      return mcpResult(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result, isError: false });
    }
    if (name === "newchat_cancel_task") {
      if (typeof args.run_id !== "string" || !/^[0-9a-f-]{36}$/i.test(args.run_id)) throw new Error("A valid run_id is required.");
      const runId = encodeURIComponent(args.run_id);
      const found = await supabaseServiceRequest(env, "agent_runs?id=eq." + runId + "&user_id=eq." + encodeURIComponent(auth.userId) + "&select=id,status,workflow_instance_id", "GET");
      if (!found.ok || !Array.isArray(found.data) || !found.data[0]) throw new Error("Agent run not found.");
      const run = found.data[0] as any;
      if (!run.workflow_instance_id || !["queued", "running", "paused"].includes(run.status)) throw new Error("This task is not currently active.");
      await (await env.AGENT_WORKFLOW.get(run.workflow_instance_id)).terminate();
      await supabaseServiceRequest(env, "agent_runs?id=eq." + runId + "&user_id=eq." + encodeURIComponent(auth.userId), "PATCH", { status: "cancelled", finished_at: new Date().toISOString(), cancel_requested_at: new Date().toISOString() });
      return mcpResult(id, { content: [{ type: "text", text: "Task " + run.id + " cancelled." }], isError: false });
    }
    return mcpError(id, -32602, "Unknown tool: " + String(name));
  } catch (error) {
    return mcpResult(id, { content: [{ type: "text", text: error instanceof Error ? error.message : "MCP tool failed." }], isError: true });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || request.headers.get("Origin") || "*";
    if (url.pathname === "/mcp") return handleMcp(request, env);
    if (request.method === "OPTIONS") return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/integrations/mcp-token") return manageMcpToken(request, env, origin);
    if (url.pathname === "/api/health") return json({
      ok: true, service: "newchat-api",
      capabilities: { chat: true, agentPlanning: true, agentExecution: Boolean(env.SUPABASE_SERVICE_ROLE_KEY && env.AGENT_WORKFLOW), sandboxExecution: Boolean(env.GITHUB_APP_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID)), githubOperations: Boolean(env.GITHUB_APP_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID)), independentGithubVerification: Boolean(env.GITHUB_APP_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID)), paidModelApproval: Boolean(env.SUPABASE_SERVICE_ROLE_KEY) },
      build_sha: env.APP_COMMIT_SHA || "unversioned",
      configuration: {
        github: Boolean(env.GITHUB_APP_TOKEN || (env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY && env.GITHUB_APP_INSTALLATION_ID)),
        supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
        openrouter: Boolean(env.OPENROUTER_API_KEY), edenai: Boolean(env.EDENAI_API_KEY)
      }
    }, 200, origin);
    if (url.pathname === "/api/agent/plan" && request.method === "POST") return createAgentPlan(request, env, origin);
    if (url.pathname === "/api/agent/start" && request.method === "POST") return startAgentExecution(request, env, origin);
    if (url.pathname === "/api/agent/control" && request.method === "POST") return controlAgentExecution(request, env, origin);
    if (url.pathname === "/api/agent/status" && request.method === "GET") return getAgentExecutionStatus(request, env, origin);
    if (url.pathname === "/api/agent/approval/decision" && request.method === "POST") return decideAgentApproval(request, env, origin);
    if (url.pathname !== "/api/chat" || request.method !== "POST") return json({ error: "Not found" }, 404, origin);

    let body: ChatRequest;
    try { body = await request.json() as ChatRequest; }
    catch { return json({ error: "Invalid JSON body." }, 400, origin); }
    if (!body || !["openrouter", "edenai"].includes(body.provider) ||
        typeof body.model !== "string" || body.model.length > 160 ||
        !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 80) {
      return json({ error: "Invalid chat request." }, 400, origin);
    }
    const allowedModels = {
      openrouter: [
        "openrouter/free", "nvidia/nemotron-3-ultra-550b-a55b:free",
        "nvidia/nemotron-3.5-super-vl:free", "nvidia/nemotron-3.5-lightning:free",
        "cohere/north-mini-code:free", "dots-studio/dots-3-note-preview:free",
        "recursive/flint-v1.0:free", "liquid/lfm-3-1.7b:free",
        "openai/gpt-4.1", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro",
        "deepseek/deepseek-r1", "x-ai/grok-3"
      ],
      edenai: [
        "google/gemma-4-31b-it", "google/gemma-4-26b-a4b-it",
        "together_ai/Prism-ML/Ternary-Bonsai-27B",
        "cloudflare/@cf/mistral/mistral-7b-instruct-v0.2-lora",
        "cloudflare/@cf/google/gemma-7b-it-lora", "cloudflare/@cf/google/gemma-2b-it-lora",
        "openai/gpt-4o", "anthropic/claude-sonnet-4-5",
        "deepseek/deepseek-r1", "google/gemini-2.5-pro"
      ]
    }[body.provider];
    if (!allowedModels.includes(body.model)) return json({ error: "This model is not enabled for the selected provider." }, 400, origin);
    const validMessages = body.messages.every(m =>
      m && ["system", "user", "assistant"].includes(m.role) &&
      typeof m.content === "string" && m.content.length <= 30000
    );
    if (!validMessages) return json({ error: "Invalid message format." }, 400, origin);
    const totalMessageBytes = body.messages.reduce((sum, message) => sum + new TextEncoder().encode(message.content).byteLength, 0);
    if (totalMessageBytes > 128_000) return json({ error: "The conversation exceeds the 128 KB request limit." }, 413, origin);
    const auth = await authenticate(request, env);
    if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
    const providerConfig = {
      openrouter: { key: env.OPENROUTER_API_KEY, name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" },
      edenai: { key: env.EDENAI_API_KEY, name: "Eden AI", endpoint: "https://api.edenai.run/v3/chat/completions" }
    }[body.provider];
    if (!providerConfig.key) return json({ error: providerConfig.name + " API key is not configured on the server." }, 503, origin);
    const paidModelIds = new Set([
      "openai/gpt-4.1", "anthropic/claude-sonnet-4", "google/gemini-2.5-pro",
      "deepseek/deepseek-r1", "x-ai/grok-3"
    ]);
    const paidModel = body.provider === "openrouter" && paidModelIds.has(body.model);
    let paidReservationId: string | null = null;
    let paidEstimateUsd = 0;
    if (body.provider === "edenai" && ["openai/gpt-4o", "anthropic/claude-sonnet-4-5", "deepseek/deepseek-r1", "google/gemini-2.5-pro"].includes(body.model)) {
      return json({ error: "Paid Eden AI routing is disabled until Eden AI returns verifiable per-request pricing and usage." }, 400, origin);
    }
    if (paidModel) {
      if (!env.SUPABASE_SERVICE_ROLE_KEY) return json({ error: "Paid models are disabled until server-side spend enforcement is configured." }, 503, origin);
      let pricing: { estimatedUsd: number; promptTokens: number; inputRate: number; outputRate: number };
      try { pricing = await estimateOpenRouterCost(body.model, body.messages, 1024); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "Could not estimate paid-model cost." }, 503, origin); }
      paidEstimateUsd = pricing.estimatedUsd;
      const actionHash = await sha256Hex(JSON.stringify({ provider: body.provider, model: body.model, messages: body.messages, max_tokens: 1024 }));
      if (!body.approval_id) {
        const created = await supabaseRequest(env, auth.token, "agent_approvals", "POST", {
          user_id: auth.userId, action_type: "paid_model",
          description: "Approve " + body.model + " for this chat request (estimated $" + paidEstimateUsd.toFixed(6) + "; daily cap $1.00).",
          payload: { provider: body.provider, model: body.model, estimated_cost_usd: paidEstimateUsd, daily_budget_usd: 1, max_tokens: 1024 },
          action_hash: actionHash, requested_by: "user",
          expires_at: new Date(Date.now() + 15 * 60_000).toISOString()
        });
        if (!created.ok || !Array.isArray(created.data) || !created.data[0]?.id) return json({ error: "Could not create the paid-model approval request." }, 500, origin);
        return json({ approval_required: true, approval_id: created.data[0].id, model: body.model, estimated_cost_usd: paidEstimateUsd, daily_budget_usd: 1 }, 402, origin);
      }
      const approved = await supabaseRequest(env, auth.token,
        "agent_approvals?id=eq." + encodeURIComponent(body.approval_id) + "&user_id=eq." + encodeURIComponent(auth.userId) + "&action_type=eq.paid_model&action_hash=eq." + actionHash + "&status=eq.approved&consumed_at=is.null&select=id",
        "GET");
      if (!approved.ok || !Array.isArray(approved.data) || !approved.data[0]) return json({ error: "Paid-model approval is missing, expired, rejected, or does not match this exact request." }, 403, origin);
      const reservation = await supabaseServiceRequest(env, "rpc/reserve_paid_model_call", "POST", {
        p_user_id: auth.userId, p_approval_id: body.approval_id, p_action_hash: actionHash,
        p_estimated_cost: paidEstimateUsd, p_daily_budget: 1, p_model_id: body.model
      });
      if (!reservation.ok || typeof reservation.data !== "string") {
        return json({ error: "Paid-model request was blocked by the approval or $1 rolling 24-hour spend limit.", detail: reservation.data }, 429, origin);
      }
      paidReservationId = reservation.data;
    }


    const headers: Record<string, string> = { Authorization: `Bearer ${providerConfig.key}`, "Content-Type": "application/json" };
    if (body.provider === "openrouter") {
      headers["HTTP-Referer"] = "https://newchat.shqiptare.workers.dev";
      headers["X-Title"] = "Newchat";
    }
    try {
      const upstream = await fetch(providerConfig.endpoint, {
        method: "POST", headers,
        body: JSON.stringify({ model: body.model, messages: body.messages, max_tokens: 1024, stream: false })
      });
      const result = await upstream.json() as {
        error?: { message?: string } | string;
        choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
      };
      if (!upstream.ok) {
        if (paidReservationId) await supabaseServiceRequest(env, "agent_run_spend?id=eq." + encodeURIComponent(paidReservationId), "PATCH", {
          cost_usd: 0, metadata: { reserved: false, estimated_cost_usd: paidEstimateUsd, provider_error: true }
        }).catch(() => undefined);
        const detail = typeof result.error === "string" ? result.error : result.error?.message;
        return json({ error: detail || `Provider request failed (${upstream.status}).` }, upstream.status, origin);
      }
      if (paidReservationId) {
        const hasReportedCost = result.usage?.cost !== undefined && result.usage?.cost !== null &&
          Number.isFinite(Number(result.usage.cost)) && Number(result.usage.cost) >= 0;
        const actualCost = hasReportedCost ? Number(result.usage.cost) : paidEstimateUsd;
        await supabaseServiceRequest(env, "agent_run_spend?id=eq." + encodeURIComponent(paidReservationId), "PATCH", {
          cost_usd: actualCost,
          input_tokens: Math.max(0, Math.floor(Number(result.usage?.prompt_tokens) || 0)),
          output_tokens: Math.max(0, Math.floor(Number(result.usage?.completion_tokens) || 0)),
          metadata: { reserved: false, estimated_cost_usd: paidEstimateUsd, actual_cost_reported: hasReportedCost }
        });
      }
      let normalized: string;
      try { normalized = extractProviderText(result); }
      catch (error) { return json({ error: error instanceof Error ? error.message : "Provider returned an unsupported response format." }, 502, origin); }
      return json({ content: normalized }, 200, origin);
    } catch {
      return json({ error: "Unable to connect to the AI provider. Please try again." }, 502, origin);
    }
  }
};
