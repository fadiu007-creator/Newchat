declare module "cloudflare:workers" {
  export interface WorkflowEvent<T> { payload: T; instanceId: string; timestamp: number; }
  export interface WorkflowStep {
    do<T>(name: string, callback: () => Promise<T>): Promise<T>;
    do<T>(name: string, config: unknown, callback: () => Promise<T>): Promise<T>;
    waitForEvent<T>(name: string, options: { type: string; timeout?: string }): Promise<T>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, Params = unknown> {
    protected env: Env;
    constructor(ctx: unknown, env: Env);
    abstract run(event: WorkflowEvent<Params>, step: WorkflowStep): Promise<unknown>;
  }
}
