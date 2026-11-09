export type AgentTaskPlan = {
  key?: string;
  task_key?: string;
  depends_on?: string[];
  dependencies?: string[];
};

export function extractProviderText(payload: any): string {
  const choice = Array.isArray(payload?.choices) ? payload.choices[0] : null;
  const message = choice?.message || {};
  const content = message.content ?? payload?.output_text;
  if (typeof content === "string" && content.trim()) return content.trim();
  if (Array.isArray(content)) {
    const text = content.map((part: any) => {
      if (typeof part === "string") return part;
      if (typeof part?.text === "string") return part.text;
      if (typeof part?.content === "string") return part.content;
      return "";
    }).join("").trim();
    if (text) return text;
  }
  const refusal = typeof message.refusal === "string" ? message.refusal : "";
  const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : "unknown";
  const providerError = typeof payload?.error === "string" ? payload.error : typeof payload?.error?.message === "string" ? payload.error.message : "";
  throw new Error(
    providerError ||
    (refusal ? `Provider refused the task: ${refusal.slice(0, 300)}` :
      `Provider returned no text content (finish_reason=${finish}). Try another eligible model or reduce the task size.`)
  );
}

export function parseJsonObject<T = any>(raw: string): T {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = text.indexOf("{");
  if (start < 0) throw new Error("Provider response did not contain a JSON object.");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) {
      try { return JSON.parse(text.slice(start, i + 1)) as T; }
      catch { throw new Error("Provider returned malformed JSON; retrying with another model."); }
    }
  }
  throw new Error("Provider returned incomplete JSON; retrying with another model.");
}

export function orderTasksByDependencies<T extends AgentTaskPlan>(tasks: T[]): T[] {
  const keyOf = (task: T) => task.key || task.task_key || "";
  const dependenciesOf = (task: T) => task.depends_on || task.dependencies || [];
  const byKey = new Map(tasks.map(task => [keyOf(task), task]));
  if (byKey.size !== tasks.length || tasks.some(task => !keyOf(task))) throw new Error("Agent plan contains duplicate or empty task keys.");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: T[] = [];
  const visit = (task: T) => {
    const key = keyOf(task);
    if (visiting.has(key)) throw new Error("Agent plan contains a dependency cycle.");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependencyKey of dependenciesOf(task)) {
      const dependency = byKey.get(dependencyKey);
      if (!dependency) throw new Error(`Agent plan references unknown dependency: ${dependencyKey}`);
      visit(dependency);
    }
    visiting.delete(key);
    visited.add(key);
    ordered.push(task);
  };
  for (const task of tasks) visit(task);
  return ordered;
}

export function orderModelFallbacks<T extends { provider: string; model_id: string; capabilities?: string[] }>(
  models: T[], taskType: string
): T[] {
  const preferred = models.filter(model => (model.capabilities || []).includes(taskType));
  const seen = new Set<string>();
  return [...preferred, ...models].filter(model => {
    const key = `${model.provider}:${model.model_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
