export type ToolEnv = {
  SANDBOX_RUNNER_URL?: string;
  SANDBOX_RUNNER_TOKEN?: string;
  GITHUB_APP_TOKEN?: string;
};

export type SandboxRequest = {
  language: "javascript" | "typescript" | "python";
  files: Array<{ path: string; content: string }>;
  command: string[];
  timeout_ms?: number;
};

const MAX_FILES = 30;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 1_000_000;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,180}$/;

export function validateSandboxRequest(input: SandboxRequest): string[] {
  const errors: string[] = [];
  if (!input || !["javascript", "typescript", "python"].includes(input.language)) errors.push("Unsupported sandbox language.");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > MAX_FILES) errors.push("Sandbox requires 1–30 source files.");
  let total = 0;
  for (const file of Array.isArray(input?.files) ? input.files : []) {
    if (!file || typeof file.path !== "string" || !SAFE_PATH.test(file.path) || file.path.includes("\\") || file.path.startsWith(".")) errors.push("A source file has an unsafe path.");
    if (typeof file?.content !== "string") errors.push("Source file content must be text.");
    else {
      const size = new TextEncoder().encode(file.content).byteLength;
      if (size > MAX_FILE_BYTES) errors.push("A source file exceeds 256 KB.");
      total += size;
    }
  }
  if (total > MAX_TOTAL_BYTES) errors.push("Total sandbox source exceeds 1 MB.");
  if (!Array.isArray(input?.command) || input.command.length < 1 || input.command.length > 12 ||
      input.command.some(part => typeof part !== "string" || part.length > 300 || /[;&|\x60\n\r]/.test(part))) {
    errors.push("Command must be a bounded argument array without shell chaining.");
  }
  const timeout = input?.timeout_ms ?? 60000;
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 180000) errors.push("Sandbox timeout must be 1–180 seconds.");
  return errors;
}

export async function executeSandbox(env: ToolEnv, input: SandboxRequest, requestId: string) {
  const errors = validateSandboxRequest(input);
  if (errors.length) throw new Error(errors.join(" "));
  if (!env.SANDBOX_RUNNER_URL || !env.SANDBOX_RUNNER_TOKEN) {
    throw new Error("Sandbox integration is not configured. Set SANDBOX_RUNNER_URL and SANDBOX_RUNNER_TOKEN as Worker secrets.");
  }
  const endpoint = new URL(env.SANDBOX_RUNNER_URL);
  if (endpoint.protocol !== "https:") throw new Error("Sandbox runner must use HTTPS.");
  const response = await fetch(endpoint.toString(), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SANDBOX_RUNNER_TOKEN}`,
      "Content-Type": "application/json",
      "X-Newchat-Request-Id": requestId
    },
    body: JSON.stringify({ ...input, timeout_ms: input.timeout_ms ?? 60000, network: "disabled", filesystem: "ephemeral", resource_limits: { memory_mb: 512, cpu_ms: 120000 } }),
    signal: AbortSignal.timeout((input.timeout_ms ?? 60000) + 10000)
  });
  const payload = await response.json().catch(() => null) as any;
  if (!response.ok) throw new Error(`Sandbox runner rejected execution (HTTP ${response.status}).`);
  if (!payload || typeof payload.exit_code !== "number" || typeof payload.stdout !== "string" || typeof payload.stderr !== "string") {
    throw new Error("Sandbox runner returned an invalid execution receipt.");
  }
  return {
    exit_code: payload.exit_code,
    stdout: payload.stdout.slice(0, 30000),
    stderr: payload.stderr.slice(0, 30000),
    duration_ms: Number.isFinite(payload.duration_ms) ? payload.duration_ms : null,
    timed_out: payload.timed_out === true,
    receipt_id: typeof payload.receipt_id === "string" ? payload.receipt_id.slice(0, 160) : null,
    passed: payload.exit_code === 0 && payload.timed_out !== true
  };
}

const GITHUB_API = "https://api.github.com";
const SAFE_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

export async function githubRequest(env: ToolEnv, repo: string, path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown) {
  if (!env.GITHUB_APP_TOKEN) throw new Error("GitHub integration is not configured. Set GITHUB_APP_TOKEN as a Worker secret.");
  if (!SAFE_REPO.test(repo) || repo.includes("..")) throw new Error("Invalid GitHub repository identifier.");
  if (!path.startsWith("/") || path.includes("..") || path.includes("://")) throw new Error("Invalid GitHub API path.");
  if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "PUT" && method !== "DELETE") throw new Error("Unsupported GitHub operation.");
  const response = await fetch(`${GITHUB_API}/repos/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_APP_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`GitHub API request failed (HTTP ${response.status}): ${raw.slice(0, 600)}`);
  return raw ? JSON.parse(raw) : null;
}

export async function verifyGitHubCommit(env: ToolEnv, repo: string, ref: string) {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) throw new Error("Invalid Git reference.");
  const commit = await githubRequest(env, repo, `/commits/${encodeURIComponent(ref)}`, "GET") as any;
  const statuses = await githubRequest(env, repo, `/commits/${encodeURIComponent(commit.sha)}/status`, "GET") as any;
  const checks = await githubRequest(env, repo, `/commits/${encodeURIComponent(commit.sha)}/check-runs`, "GET") as any;
  const checkRuns = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const statusesOk = statuses?.state === "success";
  const checksComplete = checkRuns.every((item: any) => item.status === "completed");
  const checksOk = checkRuns.length > 0 && checkRuns.every((item: any) => item.conclusion === "success");
  return {
    commit_sha: commit.sha,
    commit_verified: Boolean(commit.sha && commit.commit?.tree?.sha),
    status_state: statuses?.state || "pending",
    check_runs: checkRuns.map((item: any) => ({ name: item.name, status: item.status, conclusion: item.conclusion })),
    checks_complete: checksComplete,
    checks_passed: checksOk,
    combined_status_passed: statusesOk,
    passed: Boolean(commit.sha && statusesOk && checksComplete && checksOk)
  };
}

export function enforceSpendBudget(input: { spentUsd: number; estimatedUsd: number; budgetUsd: number }) {
  const { spentUsd, estimatedUsd, budgetUsd } = input;
  if (![spentUsd, estimatedUsd, budgetUsd].every(Number.isFinite) || spentUsd < 0 || estimatedUsd < 0 || budgetUsd < 0) {
    throw new Error("Invalid spend accounting values.");
  }
  const projected = spentUsd + estimatedUsd;
  return { allowed: projected <= budgetUsd, spent_usd: spentUsd, estimated_usd: estimatedUsd, projected_usd: projected, budget_usd: budgetUsd, remaining_usd: Math.max(0, budgetUsd - spentUsd) };
}

export function classifyConsequentialAction(action: string) {
  return ["github_write", "deployment", "database_write", "external_message", "purchase", "delete_data", "paid_model"].includes(action);
}
