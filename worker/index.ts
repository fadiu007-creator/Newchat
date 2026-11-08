import { AgentWorkflow } from "./agent-workflow";
import { AgentSandbox } from "./sandbox";
export { AgentSandbox };
export { AgentWorkflow };

export interface Env {
  ASSETS: Fetcher;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  AGENT_SANDBOX: DurableObjectNamespace<AgentSandbox>;
  AGENT_WORKFLOW: {
    create(options: { id: string; params: { runId: string; userId: string } }): Promise<{ id: string }>;
    get(id: string): Promise<{
      status(): Promise<unknown>;
      pause(): Promise<void>;
      resume(): Promise<void>;
      terminate(): Promise<void>;
    }>;
  };
  OPENROUTER_API_KEY?: string;
  EDENAI_API_KEY?: string;
  SANDBOX_RUNNER_URL?: string;
  SANDBOX_RUNNER_TOKEN?: string;
  GITHUB_APP_TOKEN?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatRequest = { provider: "openrouter" | "edenai"; model: string; messages: ChatMessage[] };
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
      headers: { apikey: env.SUPABASE_ANON_K
…[1 chars truncated — re-run with head/grep/tail for full output]…
e();
      await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}`, "PATCH", { status: "paused", paused_at: new Date().toISOString() });
    } else if (action === "resume") {
      if (!instance) return json({ error: "No active Workflow instance to resume." }, 409, origin);
      await instance.resume();
      await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}`, "PATCH", { status: "queued", paused_at: null });
    } else {
      if (instance) await instance.terminate();
      await supabaseRequest(env, auth.token, `agent_runs?id=eq.${encodeURIComponent(run.id)}`, "PATCH", { status: "cancelled", finished_at: new Date().toISOString(), cancel_requested_at: new Date().toISOString() });
    }
    await supabaseRequest(env, auth.token, "agent_events", "POST", { run_id: run.id, user_id: auth.userId, event_type: action === "pause" ? "execution_paused" : action === "resume" ? "execution_resumed" : "execution_cancelled", message: `Execution ${action} requested by the owner.` });
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
  let workflow: unknown = null;
  if (run.workflow_instance_id) {
    try { workflow = await (await env.AGENT_WORKFLOW.get(run.workflow_instance_id)).status(); } catch { workflow = { status: "unavailable" }; }
  }
  return json({ run: result.data[0], workflow }, 200, origin);
}

function classifyTask(task: { title: string; description: string }): string {
  const text = `${task.title} ${task.description}`.toLowerCase();
  if (/\b(code|coding|implement|build|develop|program|api|database|schema|test|debug|deploy|software|app)\b/.test(text)) return "coding";
  if (/\b(research|investigate|compare|sources|fact.?check|findings|market|competitor)\b/.test(text)) return "analysis";
  if (/\b(write|draft|document|proposal|email|content|copy|article|guide|report)\b/.test(text)) return "writing";
  if (/\b(analy[sz]e|review|evaluate|audit|strategy|plan|architecture)\b/.test(text)) return "analysis";
  return "general";
}

function parsePlan(raw: string): { summary: string; success_criteria: string[]; tasks: Array<{ key: string; title: string; description: string; acceptance_criteria: string[]; depends_on: string[] }> } | null {
  const cleaned = raw.trim().replace(/^\`\`\`(?:json)?\s*/i, "").replace(/\s*\`\`\`$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
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
    return { summary: parsed.summary.slice(0, 2000), success_criteria: criteria, tasks };
  } catch {
    return null;
  }
}

async function createAgentPlan(request: Request, env: Env, origin: string): Promise<Response> {
  const auth = await authenticate(request, env);
  if (isResponse(auth)) return json(await auth.json(), auth.status, origin);

  let body: { goal?: string; strategy?: Strategy; max_budget_usd?: number; max_runtime_minutes?: number; max_attempts?: number };
  try { body = await request.json() as typeof body; }
  catch { return json({ error: "Invalid JSON body." }, 400, origin); }

  const goal = typeof body.goal === "string" ? body.goal.trim() : "";
  const strategy = body.strategy || "balanced";
  const budget = body.max_budget_usd ?? 0;
  const runtime = body.max_runtime_minutes ?? 30;
  const attempts = body.max_attempts ?? 3;
  if (goal.length < 3 || goal.length > 12000) return json({ error: "Goal must contain 3–12,000 characters." }, 400, origin);
  if (!["balanced", "best_quality", "free_first"].includes(strategy)) return json({ error: "Invalid model strategy." }, 400, origin);
  if (typeof budget !== "number" || !Number.isFinite(budget) || budget < 0 || budget > 1000) return json({ error: "Budget must be between $0 and $1,000." }, 400, origin);
  if (!Number.isInteger(runtime) || runtime < 1 || runtime > 1440) return json({ error: "Runtime must be between 1 and 1,440 minutes." }, 400, origin);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 10) return json({ error: "Attempts must be between 1 and 10." }, 400, origin);
  if (!env.OPENROUTER_API_KEY) return json({ error: "OpenRouter is not configured on the Worker." }, 503, origin);

  const started = Date.now();
  const system = [
    "You are the planning component of Newchat, an autonomous goal-execution agent.",
    "Turn the user's goal into a realistic, ordered, dependency-aware plan.",
    "Do not claim to execute actions. Plan only. Include measurable acceptance criteria for every task and measurable overall success criteria.",
    "Keep the plan focused: 2 to 8 tasks for normal goals, up to 10 only when necessary. Tasks should be independently verifiable.",
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
        max_tokens: 2200,
        temperature: 0.2
      })
    });
    const result = await upstream.json() as {
      error?: { message?: string } | string;
      choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>;
    };
    if (!upstream.ok) {
      const detail = typeof result.error === "string" ? result.error : result.error?.message;
      return json({ error: detail || `Planner provider failed (HTTP ${upstream.status}).` }, 502, origin);
    }
    const content = result.choices?.[0]?.message?.content;
    const text = Array.isArray(content) ? content.map(part => part.text || "").join("") : content;
    if (typeof text !== "string") return json({ error: "Planner returned an empty response." }, 502, origin);
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
      next: "Plan saved. Start durable execution from the Agent workspace when ready."
    }, 201, origin);
  } catch {
    return json({ error: "Unable to create the agent plan. Check provider connectivity and retry." }, 502, origin);
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/health") return json({
      ok: true, service: "newchat-api",
      capabilities: { chat: true, agentPlanning: true, agentExecution: Boolean(env.SUPABASE_SERVICE_ROLE_KEY && env.AGENT_WORKFLOW), sandboxExecution: Boolean(env.AGENT_SANDBOX), githubOperations: Boolean(env.GITHUB_APP_TOKEN), independentGithubVerification: Boolean(env.GITHUB_APP_TOKEN), paidModelRouting: false },
      configuration: {
        sandboxRunner: Boolean(env.AGENT_SANDBOX), githubApp: Boolean(env.GITHUB_APP_TOKEN),
        supabase: Boolean(env.SUPABASE_URL && env.SUPABASE_ANON_KEY),
        openrouter: Boolean(env.OPENROUTER_API_KEY), edenai: Boolean(env.EDENAI_API_KEY)
      }
    }, 200, origin);
    if (url.pathname === "/api/agent/plan" && request.method === "POST") return createAgentPlan(request, env, origin);
    if (url.pathname === "/api/agent/start" && request.method === "POST") return startAgentExecution(request, env, origin);
    if (url.pathname === "/api/agent/control" && request.method === "POST") return controlAgentExecution(request, env, origin);
    if (url.pathname === "/api/agent/status" && request.method === "GET") return getAgentExecutionStatus(request, env, origin);
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

    const auth = await authenticate(request, env);
    if (isResponse(auth)) return json(await auth.json(), auth.status, origin);
    const providerConfig = {
      openrouter: { key: env.OPENROUTER_API_KEY, name: "OpenRouter", endpoint: "https://openrouter.ai/api/v1/chat/completions" },
      edenai: { key: env.EDENAI_API_KEY, name: "Eden AI", endpoint: "https://api.edenai.run/v3/chat/completions" }
    }[body.provider];
    if (!providerConfig.key) return json({ error: `${providerConfig.name} API key is not configured on the server.` }, 503, origin);
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
      };
      if (!upstream.ok) {
        const detail = typeof result.error === "string" ? result.error : result.error?.message;
        return json({ error: detail || `Provider request failed (${upstream.status}).` }, upstream.status, origin);
      }
      const content = result.choices?.[0]?.message?.content;
      const normalized = Array.isArray(content) ? content.map(part => part.text || "").join("") : content;
      if (typeof normalized !== "string") return json({ error: "Provider returned an unsupported response format." }, 502, origin);
      return json({ content: normalized }, 200, origin);
    } catch {
      return json({ error: "Unable to connect to the AI provider. Please try again." }, 502, origin);
    }
  }
};
