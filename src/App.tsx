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

const modelOptions = [
  { provider: "openrouter" as const, model: "openai/gpt-4.1", label: "GPT-4.1", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "anthropic/claude-sonnet-4", label: "Claude Sonnet", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "deepseek/deepseek-r1", label: "DeepSeek R1", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "x-ai/grok-3", label: "Grok 3", maker: "OpenRouter" },
  { provider: "edenai" as const, model: "openai/gpt-4o", label: "GPT-4o", maker: "Eden AI" },
  { provider: "edenai" as const, model: "anthropic/claude-sonnet-4-5", label: "Claude Sonnet 4.5", maker: "Eden AI" },
  { provider: "edenai" as const, model: "deepseek/deepseek-r1", label: "DeepSeek R1", maker: "Eden AI" },
  { provider: "edenai" as const, model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", maker: "Eden AI" }
];

const starterPrompts = [
  { icon: "✳", title: "Plan a project", detail: "Turn an idea into an actionable roadmap" },
  { icon: "⌘", title: "Write something", detail: "Draft, edit, or improve your writing" },
  { icon: "⌁", title: "Understand a topic", detail: "Get a clear explanation with examples" },
  { icon: "◫", title: "Analyze a document", detail: "Find insights in a file or report" }
];

const createId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const newConversation = (): Conversation => ({
  id: createId(), title: "New conversation", model: "openai/gpt-4.1",
  provider: "openrouter", messages: []
});

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
      }).catch(error => {
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
        <button className="nav-item active"><MessageSquarePlus size={16}/> Chats</button>
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
            <div className="model-picker-wrap">
              <button className="model-picker" onClick={() => setMenuOpen(v => !v)}>
                <span className="model-orb"><Bot size={16}/></span>
                <strong>{selectedModel.label}</strong><ChevronDown size={15}/>
              </button>
              {menuOpen && <div className="model-menu">
                <div className="model-menu-title">Choose a model</div>
                {modelOptions.map(m => <button key={m.provider + m.model} onClick={() => chooseModel(m)} className="model-option">
                  <span className="model-option-icon"><Bot size={15}/></span><span><strong>{m.label}</strong><small>{m.maker} · {m.model}</small></span>
                  {m.model === active.model && m.provider === active.provider && <Check size={15}/>}
                </button>)}
              </div>}
            </div>
          </div>
          <div className="topbar-actions"><span className="connection-pill"><span className={session ? "connected" : ""}/>{session ? "Signed in" : "Sign in to sync"}</span><button className="icon-button" aria-label="Help"><CircleHelp size={18}/></button></div>
        </header>

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

        <div className="composer-wrap">
          {notice && <div className="error-notice"><span>{notice}</span><button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14}/></button></div>}
          <form className="composer" onSubmit={onSubmit}>
            <textarea value={prompt} onChange={e => setPrompt(e.target.value)} onKeyDown={onKeyDown} placeholder="Message Newchat..." rows={2} />
            <div className="composer-toolbar">
              <div className="composer-tools"><button type="button" className="tool-button" title="Attach file (coming soon)"><Plus size={17}/></button><button type="button" className="tool-button" title="Attach file (coming soon)"><FilePlus2 size={16}/></button><span className="tool-divider"/><span className="provider-caption">{selectedModel.maker}</span></div>
              <div className="composer-actions"><button type="button" className="tool-button" title="Voice (coming soon)"><AudioLines size={17}/></button><button type="submit" className="send-button" disabled={!prompt.trim() || loading} aria-label="Send message">{loading ? <span className="spinner"/> : <ArrowUp size={17}/>}</button></div>
            </div>
          </form>
          <div className="disclaimer">Newchat can make mistakes. Verify important information.</div>
        </div>
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
