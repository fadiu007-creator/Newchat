export type SandboxFile = { path: string; content: string };
export type SandboxJob = { files: SandboxFile[]; argv: string[]; timeout_ms?: number };

const MAX_FILES = 30;
const MAX_FILE_BYTES = 256_000;
const MAX_TOTAL_BYTES = 1_000_000;
const MAX_TIMEOUT_MS = 180_000;
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]{1,180}$/;

export function validateSandboxJob(job: SandboxJob): string[] {
  const errors: string[] = [];
  if (!job || !Array.isArray(job.files) || job.files.length < 1 || job.files.length > MAX_FILES) errors.push("Provide between 1 and 30 files.");
  let total = 0;
  for (const file of Array.isArray(job?.files) ? job.files : []) {
    if (!file || typeof file.path !== "string" || !SAFE_PATH.test(file.path) || file.path.startsWith(".") || file.path.includes("\\")) errors.push("A file path is invalid.");
    if (typeof file?.content !== "string") errors.push("File content must be text.");
    else {
      const bytes = new TextEncoder().encode(file.content).byteLength;
      if (bytes > MAX_FILE_BYTES) errors.push("A file exceeds 256 KB.");
      total += bytes;
    }
  }
  if (total > MAX_TOTAL_BYTES) errors.push("Total source exceeds 1 MB.");
  if (!Array.isArray(job?.argv) || job.argv.length < 1 || job.argv.length > 12 || job.argv.some(x => typeof x !== "string" || !x.length || x.length > 300 || /[;&|`$\n\r]/.test(x))) errors.push("Command must be a 1–12 item argument array.");
  const timeout = job?.timeout_ms ?? 60_000;
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > MAX_TIMEOUT_MS) errors.push("Timeout must be between 1 and 180 seconds.");
  return errors;
}
