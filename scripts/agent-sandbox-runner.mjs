import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";

const requestId = process.env.NEWCHAT_SANDBOX_REQUEST_ID || randomUUID();
const resultDir = resolve("sandbox-result");
const workspace = resolve("sandbox-work", requestId);
mkdirSync(resultDir, { recursive: true });
const receipt = { request_id: requestId, passed: false, exit_code: 125, stdout: "", stderr: "", duration_ms: 0, timed_out: false, receipt_id: randomUUID() };

function finish() {
  receipt.stdout = String(receipt.stdout || "").slice(0, 5000);
  receipt.stderr = String(receipt.stderr || "").slice(0, 5000);
  writeFileSync(resolve(resultDir, "receipt.json"), JSON.stringify(receipt, null, 2));
}
try {
  if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error("Invalid sandbox request ID.");
  const encoded = process.env.NEWCHAT_SANDBOX_PAYLOAD || "";
  if (!encoded || encoded.length > 60000) throw new Error("Sandbox payload is missing or exceeds the 60 KB dispatch limit.");
  const job = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const allowedLanguages = ["javascript", "typescript", "python"];
  if (!allowedLanguages.includes(job.language)) throw new Error("Unsupported sandbox language.");
  if (!Array.isArray(job.files) || job.files.length < 1 || job.files.length > 20) throw new Error("Provide between 1 and 20 files.");
  let totalBytes = 0;
  const seen = new Set();
  for (const file of job.files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") throw new Error("Invalid source file.");
    const path = file.path;
    if (path.length > 160 || isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === "..") || !/^[A-Za-z0-9._/-]+$/.test(path)) throw new Error("Unsafe source path.");
    if (seen.has(path)) throw new Error("Duplicate source path.");
    seen.add(path);
    const size = Buffer.byteLength(file.content, "utf8");
    if (size > 16000) throw new Error("A source file exceeds 16 KB.");
    totalBytes += size;
    if (totalBytes > 32000) throw new Error("Total source exceeds 32 KB.");
  }
  if (!Array.isArray(job.command) || job.command.length < 1 || job.command.length > 12 || job.command.some(x => typeof x !== "string" || !x || x.length > 240 || /[\x00-\x1f;&|\x60]/.test(x))) throw new Error("Invalid argument-vector command.");
  const command = job.command;
  if (job.language === "python" && command[0] !== "python3") throw new Error("Python jobs must use python3.");
  if (job.language !== "python" && !["node", "npm"].includes(command[0])) throw new Error("JavaScript and TypeScript jobs must use node or npm.");
  const timeout = Number(job.timeout_ms ?? 60000);
  if (!Number.isInteger(timeout) || timeout < 1000 || timeout > 180000) throw new Error("Timeout must be between 1 and 180 seconds.");

  rmSync(workspace, { recursive: true, force: true });
  process.exitCode = 0;
  mkdirSync(workspace, { recursive: true });
  for (const file of job.files) {
    const target = resolve(workspace, file.path);
    if (!target.startsWith(workspace + "/") || relative(workspace, target).startsWith("..")) throw new Error("Source path escaped the workspace.");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content, { flag: "wx" });
  }
  chmodSync(workspace, 0o777);
  const image = job.language === "python" ? "python:3.12-slim" : "node:22-bookworm-slim";
  const pull = spawnSync("docker", ["pull", image], { encoding: "utf8", timeout: 90000, maxBuffer: 1000000 });
  if (pull.status !== 0) throw new Error("Could not prepare the sandbox runtime image: " + String(pull.stderr || pull.stdout).slice(0, 1000));
  const started = Date.now();
  const args = [
    "run", "--rm", "--label", "newchat.request-id=" + requestId,
    "--network", "none", "--cpus=1", "--memory=512m", "--memory-swap=512m",
    "--pids-limit=128", "--read-only",
    "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
    "--mount", "type=bind,src=" + workspace + ",dst=/workspace,rw",
    ...(existsSync(resolve("node_modules")) ? ["--mount", "type=bind,src=" + resolve("node_modules") + ",dst=/workspace/node_modules,readonly"] : []),
    "--workdir", "/workspace", "--user", "10001:10001", "--env", "HOME=/tmp", "--env", "npm_config_cache=/tmp/npm-cache",
    "--cap-drop=ALL", "--security-opt=no-new-privileges",
    image, ...command
  ];
  const result = spawnSync("docker", args, { encoding: "utf8", timeout: timeout + 10000, maxBuffer: 120000 });
  receipt.duration_ms = Date.now() - started;
  receipt.stdout = result.stdout || "";
  receipt.stderr = result.stderr || "";
  receipt.timed_out = result.error?.code === "ETIMEDOUT";
  receipt.exit_code = receipt.timed_out ? 124 : (typeof result.status === "number" ? result.status : 125);
  receipt.passed = receipt.exit_code === 0 && !receipt.timed_out;
  if (receipt.timed_out) {
    spawnSync("docker", ["ps", "-q", "--filter", "label=newchat.request-id=" + requestId], { encoding: "utf8" }).stdout
      .trim().split("\n").filter(Boolean).forEach(id => spawnSync("docker", ["kill", id]));
    receipt.stderr += "\nSandbox execution exceeded its time limit.";
  }
} catch (error) {
  receipt.stderr = error instanceof Error ? error.message : "Sandbox execution failed.";
} finally {
  finish();
  rmSync(workspace, { recursive: true, force: true });
}
