export type ToolEnv = {
  GITHUB_APP_TOKEN?: string;
  GITHUB_SANDBOX_REPOSITORY?: string;
  GITHUB_ALLOWED_REPOSITORIES?: string;
};

export type SandboxRequest = {
  language: "javascript" | "typescript" | "python";
  files: Array<{ path: string; content: string }>;
  command: string[];
  timeout_ms?: number;
};

export type GithubOperation = {
  action: "read_file" | "list_directory" | "create_branch" | "upsert_file" | "create_pull_request" | "merge_pull_request" | "verify_commit";
  repository: string;
  path?: string;
  branch?: string;
  base?: string;
  title?: string;
  body?: string;
  content?: string;
  pull_number?: number;
  base_sha?: string;
  commit_message?: string;
};

const SAFE_REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,160}$/;
const MAX_SANDBOX_BYTES = 32_000;

export function validateSandboxRequest(input: SandboxRequest): string[] {
  const errors: string[] = [];
  if (!input || !["javascript", "typescript", "python"].includes(input.language)) errors.push("Unsupported sandbox language.");
  if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 20) errors.push("Sandbox requires 1–20 source files.");
  let total = 0;
  const seen = new Set<string>();
  for (const file of Array.isArray(input?.files) ? input.files : []) {
    if (!file || typeof file.path !== "string" || !SAFE_PATH.test(file.path) || file.path.includes("\\") || file.path.startsWith(".")) {
      errors.push("A source file has an unsafe path.");
    } else if (seen.has(file.path)) errors.push("Source file paths must be unique.");
    else seen.add(file.path);
    if (typeof file?.content !== "string") errors.push("Source file content must be text.");
    else {
      const size = new TextEncoder().encode(file.content).byteLength;
      if (size > 16_000) errors.push("A source file exceeds 16 KB.");
      total += size;
    }
  }
  if (total > MAX_SANDBOX_BYTES) errors.push("Total sandbox source exceeds 32 KB for a GitHub Actions dispatch.");
  if (!Array.isArray(input?.command) || input.command.length < 1 || input.command.length > 12 ||
      input.command.some(part => typeof part !== "string" || !part || part.length > 240 || /[\x00-\x1f;&|\x60]/.test(part))) {
    errors.push("Command must be a bounded argument array without shell chaining.");
  }
  if (input.language === "python" && input.command?.[0] !== "python3") errors.push("Python jobs must use python3.");
  if (input.language !== "python" && input.command?.[0] !== "node") errors.push("JavaScript and TypeScript jobs must use node.");
  const timeout = input?.timeout_ms ?? 60_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 180_000) errors.push("Sandbox timeout must be 1–180 seconds.");
  return errors;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function toBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function fromBase64(value: string) {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function githubApi(env: ToolEnv, repo: string, path: string, method = "GET", body?: unknown) {
  if (!env.GITHUB_APP_TOKEN) throw new Error("GitHub integration is not configured. Add GITHUB_APP_TOKEN as a Cloudflare Worker secret.");
  if (!SAFE_REPO.test(repo) || repo.includes("..")) throw new Error("Invalid GitHub repository identifier.");
  const allowed = (env.GITHUB_ALLOWED_REPOSITORIES || env.GITHUB_SANDBOX_REPOSITORY || "fadiu007-creator/Newchat")
    .split(",").map(x => x.trim()).filter(Boolean);
  if (!allowed.includes(repo)) throw new Error("This repository is not in the configured GitHub allowlist.");
  if (!path.startsWith("/") || path.includes("..") || path.includes("://") || path.length > 500) throw new Error("Invalid GitHub API path.");
  const response = await fetch(`https://api.github.com/repos/${repo}${path}`, {
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
  if (!response.ok) throw new Error(`GitHub API request failed (HTTP ${response.status}): ${raw.slice(0, 500)}`);
  return raw ? JSON.parse(raw) as any : null;
}

export async function executeSandbox(env: ToolEnv, input: SandboxRequest, requestId: string) {
  const errors = validateSandboxRequest(input);
  if (errors.length) throw new Error(errors.join(" "));
  const repo = env.GITHUB_SANDBOX_REPOSITORY || "fadiu007-creator/Newchat";
  if (!env.GITHUB_APP_TOKEN) throw new Error("Sandbox runner requires GITHUB_APP_TOKEN with Actions write and Checks read access.");
  if (!SAFE_REPO.test(repo)) throw new Error("Invalid configured sandbox repository.");
  const request = { ...input, timeout_ms: input.timeout_ms ?? 60_000 };
  const payload = toBase64(JSON.stringify(request));
  if (payload.length > 60_000) throw new Error("Sandbox payload exceeds GitHub Actions dispatch limits.");
  const dispatch = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/agent-sandbox.yml/dispatches`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.GITHUB_APP_TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ ref: "main", inputs: { request_id: requestId, payload } })
  });
  if (dispatch.status !== 204) {
    const detail = (await dispatch.text()).slice(0, 500);
    throw new Error(`GitHub Actions sandbox dispatch failed (HTTP ${dispatch.status}): ${detail}`);
  }

  const runsUrl = `https://api.github.com/repos/${repo}/actions/workflows/agent-sandbox.yml/runs?event=workflow_dispatch&branch=main&per_page=30`;
  let run: any = null;
  const deadline = Date.now() + 210_000;
  while (Date.now() < deadline) {
    const response = await fetch(runsUrl, { headers: { Authorization: `Bearer ${env.GITHUB_APP_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" } });
    if (!response.ok) throw new Error(`Could not inspect sandbox workflow runs (HTTP ${response.status}).`);
    const data = await response.json() as any;
    run = (data.workflow_runs || []).find((item: any) =>
      item.display_title === `Newchat sandbox ${requestId}` ||
      item.name === `Newchat sandbox ${requestId}` ||
      item.display_title?.includes(requestId)
    ) || run;
    if (run?.status === "completed") break;
    await sleep(2000);
  }
  if (!run || run.status !== "completed") throw new Error("GitHub Actions sandbox did not finish within 210 seconds.");

  const checksResponse = await fetch(`https://api.github.com/repos/${repo}/commits/${run.head_sha}/check-runs?filter=all&per_page=100`, {
    headers: { Authorization: `Bearer ${env.GITHUB_APP_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
  });
  if (!checksResponse.ok) throw new Error(`Could not retrieve independent sandbox check receipt (HTTP ${checksResponse.status}).`);
  const checks = await checksResponse.json() as any;
  const check = (checks.check_runs || []).find((item: any) => item.name === "Newchat sandbox" && item.external_id === requestId);
  if (!check || check.status !== "completed" || !check.output?.summary) throw new Error("Sandbox completed without a verifiable check-run receipt.");
  let receipt: any;
  try { receipt = JSON.parse(check.output.summary); } catch { throw new Error("Sandbox check-run receipt is invalid JSON."); }
  if (receipt.request_id !== requestId || typeof receipt.exit_code !== "number" || typeof receipt.passed !== "boolean") {
    throw new Error("Sandbox receipt did not match the requested execution.");
  }
  return {
    ...receipt,
    workflow_run_id: run.id,
    workflow_url: run.html_url,
    independent_check_run_id: check.id,
    passed: receipt.passed === true && check.conclusion === "success"
  };
}

export async function githubRequest(env: ToolEnv, repo: string, path: string, method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", body?: unknown) {
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(method)) throw new Error("Unsupported GitHub operation.");
  return githubApi(env, repo, path, method, body);
}

export async function verifyGitHubCommit(env: ToolEnv, repo: string, ref: string) {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(ref) || ref.includes("..")) throw new Error("Invalid Git reference.");
  const commit = await githubApi(env, repo, `/commits/${encodeURIComponent(ref)}`, "GET") as any;
  const [statuses, checks] = await Promise.all([
    githubApi(env, repo, `/commits/${encodeURIComponent(commit.sha)}/status`, "GET"),
    githubApi(env, repo, `/commits/${encodeURIComponent(commit.sha)}/check-runs?filter=all&per_page=100`, "GET")
  ]);
  const checkRuns = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const checksComplete = checkRuns.length > 0 && checkRuns.every((item: any) => item.status === "completed");
  const checksPassed = checksComplete && checkRuns.every((item: any) => item.conclusion === "success");
  const statusPassed = statuses?.state === "success";
  return {
    commit_sha: commit.sha,
    commit_verified: Boolean(commit.sha && commit.commit?.tree?.sha),
    status_state: statuses?.state || "pending",
    check_runs: checkRuns.map((item: any) => ({ name: item.name, status: item.status, conclusion: item.conclusion })),
    checks_complete: checksComplete,
    checks_passed: checksPassed,
    combined_status_passed: statusPassed,
    passed: Boolean(commit.sha && commit.commit?.tree?.sha && statusPassed && checksPassed)
  };
}

export async function executeGithubOperation(env: ToolEnv, operation: GithubOperation, allowedRepositories: string[]) {
  const repo = operation.repository;
  if (!SAFE_REPO.test(repo) || !allowedRepositories.includes(repo)) throw new Error("GitHub repository is not allowed for this user.");
  const branch = operation.branch || "main";
  if (!/^[A-Za-z0-9._/-]{1,120}$/.test(branch) || branch.includes("..")) throw new Error("Invalid GitHub branch.");
  const path = operation.path || "";
  if (operation.action === "verify_commit") return verifyGitHubCommit(env, repo, branch);
  if (operation.action === "read_file" || operation.action === "list_directory") {
    if (!SAFE_PATH.test(path)) throw new Error("Invalid repository path.");
    const result = await githubApi(env, repo, `/contents/${path}?ref=${encodeURIComponent(branch)}`, "GET");
    if (operation.action === "list_directory") return Array.isArray(result) ? result.map((item: any) => ({ name: item.name, path: item.path, type: item.type, size: item.size })) : result;
    if (result?.type !== "file" || typeof result.content !== "string") throw new Error("Requested GitHub path is not a text file.");
    return { path: result.path, sha: result.sha, content: fromBase64(result.content) };
  }
  if (operation.action === "create_branch") {
    const base = operation.base || "main";
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(base) || base.includes("..")) throw new Error("Invalid base branch.");
    const source = await githubApi(env, repo, `/git/ref/heads/${encodeURIComponent(base)}`, "GET");
    const newBranch = operation.branch || "";
    if (!/^[A-Za-z0-9._/-]{1,120}$/.test(newBranch) || newBranch.includes("..")) throw new Error("Invalid new branch name.");
    return githubApi(env, repo, "/git/refs", "POST", { ref: `refs/heads/${newBranch}`, sha: operation.base_sha || source.object.sha });
  }
  if (operation.action === "upsert_file") {
    if (!SAFE_PATH.test(path) || typeof operation.content !== "string" || operation.content.length > 200_000) throw new Error("Invalid GitHub file update.");
    const message = (operation.commit_message || "Update via Newchat agent").slice(0, 200);
    let sha: string | undefined;
    const current = await fetch(`https://api.github.com/repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`, {
      headers: { Authorization: `Bearer ${env.GITHUB_APP_TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" }
    });
    if (current.ok) { const file = await current.json() as any; sha = file.sha; }
    else if (current.status !== 404) throw new Error(`Could not inspect existing GitHub file (HTTP ${current.status}).`);
    return githubApi(env, repo, `/contents/${path}`, "PUT", {
      message, content: toBase64(operation.content), branch, ...(sha ? { sha } : {})
    });
  }
  if (operation.action === "create_pull_request") {
    if (!operation.title?.trim() || !operation.branch || !operation.base) throw new Error("Pull requests require a title, head branch, and base branch.");
    return githubApi(env, repo, "/pulls", "POST", {
      title: operation.title.slice(0, 240), body: (operation.body || "").slice(0, 6000),
      head: operation.branch, base: operation.base
    });
  }
  if (operation.action === "merge_pull_request") {
    if (!Number.isInteger(operation.pull_number) || Number(operation.pull_number) < 1) throw new Error("A valid pull request number is required.");
    return githubApi(env, repo, `/pulls/${operation.pull_number}/merge`, "PUT", { merge_method: "squash" });
  }
  throw new Error("Unsupported GitHub operation.");
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

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}
