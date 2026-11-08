import { Files } from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";

import { validateSandboxJob, type SandboxJob } from "./sandbox-validation";

const WORKSPACE = "/workspace";
const MAX_OUTPUT_BYTES = 30_000;
type SandboxEnv = Record<string, never>;

export class AgentSandbox extends DurableObject<SandboxEnv> {
  private readonly files: Files;
  constructor(ctx: DurableObjectState, env: SandboxEnv) {
    super(ctx, env);
    if (!ctx.container) throw new Error("Cloudflare sandbox container binding is missing.");
    this.files = new Files(ctx.container);
  }

  async execute(job: SandboxJob) {
    const errors = validateSandboxJob(job);
    if (errors.length) throw new Error(errors.join(" "));
    const container = this.ctx.container;
    if (!container) throw new Error("Cloudflare sandbox container binding is missing.");
    if (!container.running) {
      container.start({ image: container.images.workspace, enableInternet: false });
      await container.setInactivityTimeout(5 * 60 * 1000);
    }
    await this.files.remove(WORKSPACE, { recursive: true, force: true }).catch(() => undefined);
    await this.files.mkdir(WORKSPACE, { recursive: true });
    for (const file of job.files) {
      const path = `${WORKSPACE}/${file.path}`;
      const parent = path.slice(0, path.lastIndexOf("/"));
      await this.files.mkdir(parent, { recursive: true });
      await this.files.writeFile(path, file.content);
    }
    const started = Date.now();
    const timeoutSignal = AbortSignal.timeout(job.timeout_ms ?? 60_000);
    try {
      const process = await container.exec(job.argv, {
        cwd: WORKSPACE, signal: timeoutSignal, stdout: "pipe", stderr: "pipe"
      });
      const output = await process.output();
      const exitCode = output.exitCode;
      return {
        exit_code: exitCode,
        stdout: new TextDecoder().decode(output.stdout).slice(0, MAX_OUTPUT_BYTES),
        stderr: new TextDecoder().decode(output.stderr).slice(0, MAX_OUTPUT_BYTES),
        duration_ms: Date.now() - started,
        timed_out: false,
        receipt_id: crypto.randomUUID(),
        passed: exitCode === 0
      };
    } catch (error) {
      if (!timeoutSignal.aborted) throw error;
      return {
        exit_code: 124, stdout: "", stderr: "Sandbox execution exceeded its time limit.",
        duration_ms: Date.now() - started, timed_out: true,
        receipt_id: crypto.randomUUID(), passed: false
      };
    }
  }
}
