import { FormEvent, KeyboardEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, supabaseConfigured } from "./lib/supabase";
import {
  ArrowUp, AudioLines, Bot, Check, ChevronDown, CircleHelp,
  Download, FilePlus2, Globe2, Menu, MessageSquarePlus, MoreHorizontal,
  PanelLeftClose, Pencil, Plus, Search, Settings2, Sparkles, SquarePen, Trash2, X
} from "lucide-react";

type Provider = "openrouter" | "edenai";
type Message = { id: string; role: "user" | "assistant"; content: string };
type Conversation = { id: string; title: string; model: string; provider: Provider; messages: Message[] };
type AgentTask = { id?: string; task_key: string; position: number; title: string; description: string; acceptance_criteria: string[]; dependencies: string[]; status: string; verification_status?: string; result?: any };
type AgentArtifact = { id: string; name: string; mime_type: string; content_text?: string | null; created_at: string };
type AgentEvent = { id: string; event_type: string; message: string; created_at: string };
type AgentPlan = { run_id: string; status: string; summary: string; success_criteria: string[]; tasks: AgentTask[]; planner?: { provider: string; model: string; cost_policy?: string }; next?: string };

const modelOptions = [
  { provider: "openrouter" as const, model: "openrouter/free", label: "Auto · Free models", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super VL", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "cohere/north-mini-code:free", label: "North Mini Code", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "dots-studio/dots-3-note-preview:free", label: "Dots3-Note Preview", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "recursive/flint-v1.0:free", label: "Flint", maker: "OpenRouter", free: true },
  { provider: "openrouter" as const, model: "liquid/lfm-3-1.7b:free", label: "LFM3 1.7B", maker: "OpenRouter", free: true },
  { provider: "edenai" as const, model: "google/gemma-4-31b-it", label: "Gemma 4 31B", maker: "Eden AI", free: true },
  { provider: "edenai" as const, model: "google/gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B", maker: "Eden AI", free: true },
  { provider: "edenai" as const, model: "together_ai/Prism-ML/Ternary-Bonsai-27B", label: "Ternary Bonsai 27B", maker: "Eden AI", free: true },
  { provider: "edenai" as const, model: "cloudflare/@cf/mistral/mistral-7b-instruct-v0.2-lora", label: "Mistral 7B Instruct", maker: "Eden AI", free: true },
  { provider: "edenai" as const, model: "cloudflare/@cf/google/gemma-7b-it-lora", label: "Gemma 7B IT", maker: "Eden AI", free: true },
  { provider: "edenai" as const, model: "cloudflare/@cf/google/gemma-2b-it-lora", label: "Gemma 2B IT", maker: "Eden AI", free: true },
  { provider: "openrouter" as const, model: "openai/gpt-4.1", label: "GPT-4.1", maker: "OpenRouter", free: false },
  { provider: "openrouter" as const, model: "anthropic/claude-sonnet-4", label: "Claude Sonnet", maker: "OpenRouter", free: false },
  { provider: "openrouter" as const, model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", maker: "OpenRouter", free: false },
  { provider: "openrouter" as const, model: "deepseek/deepseek-r1", label: "DeepSeek R1", maker: "OpenRouter", free: false },
  { provider: "openrouter" as const, model: "x-ai/grok-3", label: "Grok 3", maker: "OpenRouter", free: false },
  { provider: "edenai" as const, model: "openai/gpt-4o", label: "GPT-4o", maker: "Eden AI", free: false },
  { provider: "edenai" as const, model: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", maker: "Eden AI", free: false },
  { provider: "edenai" as const, model: "deepseek/deepseek-r1", label: "DeepSeek R1", maker: "Eden AI", free: false },
  { provider: "edenai" as const, model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", maker: "Eden AI", free: false }
];

const starterPrompts = [
  { icon: "✳", title: "Plan a project", detail: "Turn an idea into an actionable roadmap" },
  { icon: "⌘", title: "Write something", detail: "Draft, edit, or improve your writing" },
  { icon: "⌁", title: "Understand a topic", detail: "Get a clear explanation with examples" },
  { icon: "◫", title: "Analyze a document", detail: "Find insights in a file or report" }
];

const createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const newConversation = (): Conversation => ({
  id: createId(), title: "New conversation", model: "openrouter/free",
  provider: "openrouter", messages: []
});


function AgentWorkspace({ session, onSignIn }: { session: Session | null; onSignIn: () => void }) {
  const [goal, setGoal] = useState("");
  const [strategy, setStrategy] = useState<"balanced" | "best_quality" | "free_first">("balanced");
  const [budget, setBudget] = useState("0");
  const [planning, setPlanning] = useState(false);
  const [plan, setPlan] = useState<AgentPlan | null>(null);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState("");
  const [artifacts, setArtifacts] = useState<AgentArtifact[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    if (!supabase || !session) return;
    let active = true;
    void supabase.from("agent_runs")
      .select("id,summary,status,success_criteria,agent_tasks(id,task_key,position,title,description,acceptance_criteria,dependencies,status)")
      .order("created_at", { ascending: false }).limit(1).maybeSingle()
      .then(({ data }) => {
        if (!active || !data) return;
        const savedTasks = Array.isArray(data.agent_tasks) ? data.agent_tasks as AgentTask[] : [];
        setPlan({
          run_id: data.id, status: data.status, summary: data.summary,
          success_criteria: Array.isArray(data.success_criteria) ? data.success_criteria as string[] : [],
          tasks: savedTasks.sort((x, y) => x.position - y.position),
          planner: { provider: "openrouter", model: "Plan saved from previous session" }
        });
      });
    return () => { active = false; };
  }, [session?.user.id]);


  async function refreshRun(runId: string) {
    if (!supabase || !session) return;
    const [runResult, taskResult, eventResult, artifactResult] = await Promise.all([
      supabase.from("agent_runs").select("id,status,summary,success_criteria").eq("id", runId).maybeSingle(),
      supabase.from("agent_tasks").select("id,task_key,position,title,description,acceptance_criteria,dependencies,status,verification_status,result").eq("run_id", runId).order("position"),
      supabase.from("agent_events").select("id,event_type,message,created_at").eq("run_id", runId).order("created_at", { ascending: false }).limit(30),
      supabase.from("agent_artifacts").select("id,name,mime_type,content_text,created_at").eq("run_id", runId).order("created_at", { ascending: false }).limit(30)
    ]);
    const runData = runResult.data;
    if (runData) setPlan(previous => previous && previous.run_id === runId ? {
      ...previous, status: runData.status, summary: runData.summary,
      success_criteria: runData.success_criteria || [],
      tasks: taskResult.data || previous.tasks
    } : previous);
    if (eventResult.data) setEvents(eventResult.data as AgentEvent[]);
    if (artifactResult.data) setArtifacts(artifactResult.data as AgentArtifact[]);
  }

  async function runAction(action: "start" | "pause" | "resume" | "cancel") {
    if (!session || !plan || busyAction) return;
    setBusyAction(action); setError("");
    try {
      const response = await fetch(action === "start" ? "/api/agent/start" : "/api/agent/control", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify(action === "start" ? { run_id: plan.run_id } : { run_id: plan.run_id, action })
      });
      const data = await response.json().catch(() => ({})) as { error?: string; status?: string };
      if (!response.ok) throw new Error(data.error || `Agent action failed (HTTP ${response.status}).`);
      await refreshRun(plan.run_id);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Agent action failed.");
    } finally { setBusyAction(""); }
  }

  useEffect(() => {
    if (!plan?.run_id || !session) return;
    void refreshRun(plan.run_id);
    if (!["queued", "running"].includes(plan.status)) return;
    const timer = window.setInterval(() => { void refreshRun(plan.run_id); }, 4000);
    return () => window.clearInterval(timer);
  }, [plan?.run_id, plan?.status, session?.user.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!session) { onSignIn(); return; }
    if (goal.trim().length < 3 || planning) return;
    const spend = Number(budget);
    if (!Number.isFinite(spend) || spend < 0 || spend > 1000) { setError("Enter a budget between $0 and $1,000."); return; }
    setPlanning(true); setError(""); setPlan(null);
    try {
      const response = await fetch("/api/agent/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ goal: goal.trim(), strategy, max_budget_usd: spend, max_runtime_minutes: 30, max_attempts: 3 })
      });
      const data = await response.json().catch(() => ({})) as AgentPlan & { error?: string };
      if (!response.ok) throw new Error(data.error || "Planning failed (HTTP " + response.status + ").");
      setPlan(data);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not create the plan.");
    } finally { setPlanning(false); }
  }

  return (
    <section className="agent-workspace">
      <div className="agent-hero">
        <div className="welcome-icon"><Sparkles size={23}/></div>
        <div className="agent-eyebrow">GOAL-BASED WORKSPACE</div>
        <h1>What do you want<br/><span>to accomplish?</span></h1>
        <p>Describe the outcome. Newchat will break it into verifiable tasks and prepare an execution plan.</p>
      </div>
      <form className="agent-goal-form" onSubmit={submit}>
        <textarea value={goal} onChange={e => setGoal(e.target.value)} placeholder="Example: Build and deploy a complete invoicing app with user accounts, a database, tests and a production deployment…" rows={4} maxLength={12000}/>
        <div className="agent-settings-row">
          <label>Model strategy<select value={strategy} onChange={e => setStrategy(e.target.value as typeof strategy)}>
            <option value="balanced">Balanced · cost and quality</option>
            <option value="free_first">Free models first</option>
            <option value="best_quality">Best quality · approval before paid use</option>
          </select></label>
          <label>Maximum spend (USD)<input type="number" min="0" max="1000" step="0.50" value={budget} onChange={e => setBudget(e.target.value)}/></label>
        </div>
        <p className="agent-strategy-note">The selected strategy is saved with this run. Per-task model routing and paid-model approval are part of the execution phase; planning currently uses OpenRouter’s free route.</p>
        <div className="agent-form-footer">
          <span><Check size={14}/> No manual model selection · free planning route</span>
          <button type="submit" className="agent-plan-button" disabled={planning || goal.trim().length < 3}>
            {planning ? "Creating plan…" : <><Sparkles size={16}/> Create plan <ArrowUp size={16}/></>}
          </button>
        </div>
      </form>
      {error && <div className="error-notice agent-notice">{error}</div>}
      {plan && <div className="agent-plan-card">
        <div className="agent-plan-header"><div><span className="agent-eyebrow">PLAN CREATED</span><h2>{plan.summary}</h2></div><span className="agent-status">{plan.status}</span></div>
        <div className="agent-run-meta">Run ID: {plan.run_id} · Planner: {plan.planner?.model || "Saved plan"} · {plan.tasks.length} tasks</div>
        <h3>Success criteria</h3>
        <ul className="agent-criteria">{plan.success_criteria.map((criterion, i) => <li key={i}><Check size={14}/>{criterion}</li>)}</ul>
        <h3>Execution tasks</h3>
        <div className="agent-task-list">{plan.tasks.map(task => <article className="agent-task" key={task.task_key}>
          <span className="agent-task-number">{task.position}</span>
          <div><strong>{task.title}</strong><p>{task.description}</p><ul>{task.acceptance_criteria.map((criterion, i) => <li key={i}>{criterion}</li>)}</ul>{task.dependencies.length > 0 && <small>Depends on: {task.dependencies.join(", ")}</small>}</div>
          <span className="agent-task-state">{task.status}</span>
        </article>)}</div>
        <div className="agent-run-controls">
          {plan.status === "planned" && <button className="agent-plan-button" onClick={() => void runAction("start")} disabled={!!busyAction}>{busyAction === "start" ? "Starting…" : "Start execution"}</button>}
          {plan.status === "paused" && <button className="agent-plan-button" onClick={() => void runAction("resume")} disabled={!!busyAction}>{busyAction === "resume" ? "Resuming…" : "Resume"}</button>}
          {["queued", "running"].includes(plan.status) && <button className="agent-secondary-button" onClick={() => void runAction("pause")} disabled={!!busyAction}>{busyAction === "pause" ? "Pausing…" : "Pause"}</button>}
          {["queued", "running", "paused"].includes(plan.status) && <button className="agent-danger-button" onClick={() => void runAction("cancel")} disabled={!!busyAction}>{busyAction === "cancel" ? "Stopping…" : "Stop"}</button>}
          <span className="agent-status">{plan.status}</span>
        </div>
        {artifacts.length > 0 && <div className="agent-output-section"><h3>Deliverables ({artifacts.length})</h3>{artifacts.map(file => <details className="agent-artifact" key={file.id}><summary>{file.name} <small>{file.mime_type}</small></summary><pre>{file.content_text || "Stored artifact."}</pre></details>)}</div>}
        {events.length > 0 && <div className="agent-output-section"><h3>Execution activity</h3><ol className="agent-event-list">{events.map(item => <li key={item.id}><strong>{item.event_type.replaceAll("_", " ")}</strong><span>{item.message}</span><time>{new Date(item.created_at).toLocaleString()}</time></li>)}</ol></div>}
        <div className="agent-execution-note"><strong>Execution uses free model routes only.</strong><span>Newchat records model-generated deliverables and criterion evidence. External browser automation, sandboxed code execution, GitHub writes and production deployment are not connected yet; the agent will not claim those actions were performed.</span></div>
      </div>}
    </section>
  );
}

export default function App() {
  const [conversations, setConversations] = useState<Conversation[]>([newConversation()]);
  const [activeId, setActiveId] = useState(conversations[0].id);
  const [prompt, setPrompt] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const [authOpen, setAuthOpen] = useState(false);
  const [authMode, setAuthMode] = useState<"signin" | "signup">("signin");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState("");
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"agent" | "chat">("agent");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const active = conversations.find(c => c.id === activeId) ?? conversations[0];
  const selectedModel = modelOptions.find(m => m.model === active.model && m.provider === active.provider) ?? modelOptions[0];
  const grouped = useMemo(() => conversations.filter(c => c.messages.length > 0 && c.title.toLowerCase().includes(searchTerm.toLowerCase())), [conversations, searchTerm]);
  useEffect(() => {
    if (!supabase) return;
    void supabase.auth.getSession().then(
      ({ data }) => setSession(data.session),
      (error: unknown) => {
        setNotice(error instanceof Error ? `Authentication startup failed: ${error.message}` : "Authentication startup failed.");
      }
    );
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setHistoryLoaded(false);
    });
    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!supabase || !session) {
      setHistoryLoaded(false);
      return;
    }
    let cancelled = false;
    void supabase.from("conversations").select("id,title,model,provider,messages")
      .order("updated_at", { ascending: false }).then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          setNotice("Could not load saved conversations: " + error.message);
        } else if (data?.length) {
          const saved = data.map(row => ({
            id: row.id, title: row.title, model: row.model,
            provider: row.provider as Provider, messages: Array.isArray(row.messages) ? row.messages as Message[] : []
          }));
          setConversations(saved);
          setActiveId(saved[0].id);
        } else {
          const fresh = newConversation();
          setConversations([fresh]);
          setActiveId(fresh.id);
        }
        setHistoryLoaded(true);
      }, (error: unknown) => {
        if (cancelled) return;
        setNotice(error instanceof Error ? "Could not load saved conversations: " + error.message : "Could not load saved conversations.");
        setHistoryLoaded(true);
      });
    return () => { cancelled = true; };
  }, [session?.user.id]);

  useEffect(() => {
    if (!supabase || !session || !historyLoaded) return;
    const rows = conversations.map(c => ({
      id: c.id, user_id: session.user.id, title: c.title,
      model: c.model, provider: c.provider, messages: c.messages,
      updated_at: new Date().toISOString()
    }));
    if (rows.length) void supabase.from("conversations").upsert(rows, { onConflict: "id" })
      .then(({ error }) => { if (error) setNotice("Conversation save failed: " + error.message); });
  }, [conversations, session?.user.id, historyLoaded]);

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (!supabase || authBusy) return;
    setAuthBusy(true);
    setAuthError("");
    try {
      const result = authMode === "signup"
        ? await supabase.auth.signUp({ email: authEmail.trim(), password: authPassword })
        : await supabase.auth.signInWithPassword({ email: authEmail.trim(), password: authPassword });
      if (result.error) {
        setAuthError(result.error.message);
      } else if (authMode === "signup" && !result.data.session) {
        setAuthError("Check your email to confirm your account, then sign in.");
      } else {
        setAuthOpen(false);
        setAuthPassword("");
      }
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : "Authentication failed. Please try again.");
    } finally {
      setAuthBusy(false);
    }
  }

  async function signOut() {
    if (supabase) await supabase.auth.signOut();
    setConversations([newConversation()]);
    setAuthOpen(false);
  }


  function updateConversation(id: string, update: (c: Conversation) => Conversation) {
    setConversations(prev => prev.map(c => c.id === id ? update(c) : c));
  }

  function updateActive(update: (c: Conversation) => Conversation) {
    updateConversation(activeId, update);
  }

  async function deleteConversation(id: string) {
    const target = conversations.find(c => c.id === id);
    if (!target || !window.confirm(`Delete "${target.title}"? This cannot be undone.`)) return;
    if (supabase && session) {
      const { error } = await supabase.from("conversations").delete().eq("id", id);
      if (error) { setNotice("Could not delete conversation: " + error.message); return; }
    }
    const remaining = conversations.filter(c => c.id !== id);
    if (remaining.length) {
      setConversations(remaining);
      if (activeId === id) setActiveId(remaining[0].id);
    } else {
      const fresh = newConversation();
      setConversations([fresh]);
      setActiveId(fresh.id);
    }
  }

  function renameConversation(id: string) {
    const current = conversations.find(c => c.id === id);
    if (!current) return;
    const title = window.prompt("Rename conversation", current.title)?.trim();
    if (!title) return;
    setConversations(prev => prev.map(c => c.id === id ? { ...c, title: title.slice(0, 100) } : c));
  }

  function exportConversation(conversation: Conversation) {
    const transcript = [
      `# ${conversation.title}`,
      `Model: ${conversation.model} (${conversation.provider})`,
      "",
      ...conversation.messages.flatMap(m => [`## ${m.role === "user" ? "You" : "Assistant"}`, m.content, ""])
    ].join("\n");
    const blob = new Blob([transcript], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${conversation.title.replace(/[^a-z0-9-_]+/gi, "-").slice(0, 60) || "newchat"}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function createConversation() {
    const next = newConversation();
    setConversations(prev => [next, ...prev]);
    setActiveId(next.id);
    setPrompt("");
    setNotice("");
  }

  async function sendMessage(text = prompt) {
    const value = text.trim();
    if (!value || loading) return;
    if (!session) { setAuthOpen(true); setNotice("Sign in to send messages and save your chat history."); return; }
    const conversationId = active.id;
    const userMessage: Message = { id: createId(), role: "user", content: value };
    const history = [...active.messages, userMessage];
    updateConversation(conversationId, c => ({
      ...c,
      title: c.messages.length === 0 ? value.slice(0, 42) : c.title,
      messages: history
    }));
    setPrompt("");
    setLoading(true);
    setNotice("");
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
        body: JSON.stringify({
          provider: active.provider,
          model: active.model,
          max_tokens: 1024,
          messages: history.map(({ role, content }) => ({ role, content }))
        })
      });
      const data = await response.json().catch(() => ({})) as { error?: string; content?: string };
      if (!response.ok) throw new Error(data.error || `The model request failed (HTTP ${response.status}).`);
      const assistantMessage: Message = {
        id: createId(), role: "assistant", content: data.content || "The provider returned an empty response."
      };
      updateConversation(conversationId, c => ({ ...c, messages: [...c.messages, assistantMessage] }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unable to reach the AI service.";
      setNotice(message);
    } finally {
      setLoading(false);
    }
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    void sendMessage();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }

  function chooseModel(model: typeof modelOptions[number]) {
    updateActive(c => ({ ...c, model: model.model, provider: model.provider }));
    setMenuOpen(false);
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${sidebarOpen ? "" : "sidebar-hidden"}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={17} /></div>
          <span className="brand-name">newchat</span>
          <button className="icon-button sidebar-collapse" aria-label="Collapse sidebar" onClick={() => setSidebarOpen(false)}><PanelLeftClose size={17}/></button>
        </div>
        <button className="new-chat-button" onClick={createConversation}><SquarePen size={16}/> New chat <span>⌘ K</span></button>
        <button className={`nav-item ${searchOpen ? "active" : ""}`} onClick={() => { setSearchOpen(v => !v); setSearchTerm(""); }}><Search size={16}/> Search chats</button>{searchOpen && <input className="history-search" autoFocus placeholder="Search conversations…" value={searchTerm} onChange={e => setSearchTerm(e.target.value)}/>}
        <div className="sidebar-label">WORKSPACE</div>
        <button className={"nav-item " + (workspaceMode === "agent" ? "active" : "")} onClick={() => setWorkspaceMode("agent")}><Sparkles size={16}/> Agent workspace</button>
        <button className={"nav-item " + (workspaceMode === "chat" ? "active" : "")} onClick={() => setWorkspaceMode("chat")}><MessageSquarePlus size={16}/> Chats</button>
        <button className="nav-item"><Globe2 size={16}/> Explore models <span className="soon">Soon</span></button>
        <div className="history-heading"><span className="sidebar-label">RECENT</span><MoreHorizontal size={16}/></div>
        <div className="history-list">
          {grouped.map(c => <div key={c.id} className={`history-row ${c.id === activeId ? "selected" : ""}`}><button className="history-item" onClick={() => setActiveId(c.id)}>{c.title}</button><div className="history-actions"><button title="Rename" aria-label="Rename conversation" onClick={() => renameConversation(c.id)}><Pencil size={12}/></button><button title="Export Markdown" aria-label="Export conversation" onClick={() => exportConversation(c)}><Download size={12}/></button><button title="Delete" aria-label="Delete conversation" onClick={() => void deleteConversation(c.id)}><Trash2 size={12}/></button></div></div>)}
          {grouped.length === 0 && <div className="empty-history">{searchTerm ? "No matching conversations." : "Your conversations will appear here."}</div>}
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item"><Settings2 size={16}/> Settings</button>
          <div className="profile-row"><div className="avatar">{session ? (session.user.email?.[0]?.toUpperCase() || "U") : "N"}</div><div><strong>{session?.user.email || "Guest workspace"}</strong><small>{session ? "Signed in" : "Not signed in"}</small></div>{session ? <button className="profile-action" onClick={() => void signOut()}>Sign out</button> : <button className="profile-action" onClick={() => setAuthOpen(true)}>Sign in</button>}</div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-left">
            {!sidebarOpen && <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open sidebar"><Menu size={18}/></button>}
            {workspaceMode === "chat" && <div className="model-picker-wrap">
              <button className="model-picker" onClick={() => setMenuOpen(v => !v)}>
                <span className="model-orb"><Bot size={16}/></span>
                <strong>{selectedModel.label}</strong><ChevronDown size={15}/>
              </button>
              {menuOpen && <div className="model-menu">
                <div className="model-menu-title">Free models · no model charge</div>
                {modelOptions.filter(m => m.free).map(m => <button key={m.provider + m.model} onClick={() => chooseModel(m)} className="model-option">
                  <span className="model-option-icon"><Bot size={15}/></span><span><strong>{m.label}<em className="free-tag">FREE</em></strong><small>{m.maker} · {m.model}</small></span>
                  {m.model === active.model && m.provider === active.provider && <Check size={15}/>}
                </button>)}
                <div className="model-menu-title paid-model-heading">Paid models · usage charges may apply</div>
                {modelOptions.filter(m => !m.free).map(m => <button key={m.provider + m.model} onClick={() => chooseModel(m)} className="model-option">
                  <span className="model-option-icon"><Bot size={15}/></span><span><strong>{m.label}</strong><small>{m.maker} · {m.model}</small></span>
                  {m.model === active.model && m.provider === active.provider && <Check size={15}/>}
                </button>)}
              </div>}
            </div>}
            {workspaceMode === "agent" && <div className="agent-topbar-title"><Sparkles size={16}/> Autonomous agent</div>}
          </div>
          <div className="topbar-actions"><span className="connection-pill"><span className={session ? "connected" : ""}/>{session ? "Signed in" : "Sign in to sync"}</span><button className="icon-button" aria-label="Help"><CircleHelp size={18}/></button></div>
        </header>

        {workspaceMode === "agent" ? <AgentWorkspace session={session} onSignIn={() => setAuthOpen(true)}/> : (
        <section className={`chat-area ${active.messages.length ? "has-messages" : ""}`}>
          {active.messages.length === 0 ? (
            <div className="welcome">
              <div className="welcome-icon"><Sparkles size={23}/></div>
              <h1>One workspace.<br/><span>Every AI conversation.</span></h1>
              <p>Choose a model and start thinking. Your AI workspace is just getting started.</p>
              <div className="starter-grid">
                {starterPrompts.map(item => <button key={item.title} className="starter-card" onClick={() => setPrompt(item.title + ": ")}><span>{item.icon}</span><strong>{item.title}</strong><small>{item.detail}</small></button>)}
              </div>
            </div>
          ) : (
            <div className="messages">
              {active.messages.map(m => <article key={m.id} className={`message ${m.role}`}>
                <div className="message-avatar">{m.role === "assistant" ? <Sparkles size={16}/> : "N"}</div>
                <div className="message-body"><div className="message-author">{m.role === "assistant" ? selectedModel.label : "You"}</div><div className="message-content">{m.content}</div></div>
              </article>)}
              {loading && <article className="message assistant"><div className="message-avatar"><Sparkles size={16}/></div><div className="message-body"><div className="message-author">{selectedModel.label}</div><div className="typing"><i/><i/><i/></div></div></article>}
              <div className="bottom-anchor"/>
            </div>
          )}
        </section>
        )}

        {workspaceMode === "chat" && <div className="composer-wrap">
          {notice && <div className="error-notice"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14}/></button></div>}
          <form className="composer" onSubmit={onSubmit}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={onKeyDown} placeholder="Message Newchat..." rows={2} />
            <div className="composer-toolbar">
              <div className="composer-tools"><button type="button" className="tool-button" title="Attach file (coming soon)"><Plus size={17}/></button><button type="button" className="tool-button" title="Attach file (coming soon)"><FilePlus2 size={16}/></button><span className="tool-divider"/><span className="provider-caption">{selectedModel.maker}</span></div>
              <div className="composer-actions"><button type="button" className="tool-button" title="Voice (coming soon)"><AudioLines size={17}/></button><button type="submit" className="send-button" disabled={!prompt.trim() || loading} aria-label="Send message">{loading ? <span className="spinner"/> : <ArrowUp size={17}/>}</button></div>
            </div>
          </form>
          <div className="disclaimer">Newchat can make mistakes. Verify important information.</div>
        </div>}
      </main>
      {authOpen && <div className="auth-backdrop" role="presentation" onMouseDown={e => { if (e.target === e.currentTarget) setAuthOpen(false); }}>
        <section className="auth-card" role="dialog" aria-modal="true" aria-labelledby="auth-title">
          <button className="auth-close" onClick={() => setAuthOpen(false)} aria-label="Close"><X size={18}/></button>
          <div className="welcome-icon"><Sparkles size={21}/></div>
          <h2 id="auth-title">{authMode === "signin" ? "Welcome back" : "Create your account"}</h2>
          <p>Sign in to save and sync your conversations.</p>
          {!supabaseConfigured ? <div className="error-notice">Supabase is not configured. Add VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to your environment.</div> : <>
            <form onSubmit={submitAuth} className="auth-form">
              <input type="email" value={authEmail} onChange={e => setAuthEmail(e.target.value)} placeholder="Email address" required/>
              <input type="password" value={authPassword} onChange={e => setAuthPassword(e.target.value)} placeholder="Password (minimum 6 characters)" minLength={6} required/>
              <button type="submit" disabled={authBusy}>{authBusy ? "Please wait…" : authMode === "signin" ? "Sign in" : "Create account"}</button>
            </form>
            {authError && <div className="auth-error">{authError}</div>}
            <button className="auth-switch" onClick={() => { setAuthMode(authMode === "signin" ? "signup" : "signin"); setAuthError(""); }}>{authMode === "signin" ? "New to Newchat? Create an account" : "Already have an account? Sign in"}</button>
          </>}
        </section>
      </div>}
    </div>
  );
}
