import { FormEvent, KeyboardEvent, useMemo, useState } from "react";
import {
  ArrowDown, ArrowUp, AudioLines, Bot, Check, ChevronDown, CircleHelp,
  Command, FilePlus2, Globe2, Menu, MessageSquarePlus, MoreHorizontal,
  PanelLeftClose, Plus, Search, Settings2, Sparkles, SquarePen, X
} from "lucide-react";

type Provider = "openrouter" | "openai";
type Message = { id: string; role: "user" | "assistant"; content: string };
type Conversation = { id: string; title: string; model: string; provider: Provider; messages: Message[] };

const modelOptions = [
  { provider: "openrouter" as const, model: "openai/gpt-4.1", label: "GPT-4.1", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "anthropic/claude-sonnet-4", label: "Claude Sonnet", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "deepseek/deepseek-r1", label: "DeepSeek R1", maker: "OpenRouter" },
  { provider: "openrouter" as const, model: "x-ai/grok-3", label: "Grok 3", maker: "OpenRouter" },
  { provider: "openai" as const, model: "gpt-4.1", label: "GPT-4.1", maker: "Direct OpenAI" },
  { provider: "openai" as const, model: "o3", label: "o3", maker: "Direct OpenAI" }
];

const starterPrompts = [
  { icon: "✳", title: "Plan a project", detail: "Turn an idea into an actionable roadmap" },
  { icon: "⌘", title: "Write something", detail: "Draft, edit, or improve your writing" },
  { icon: "⌁", title: "Understand a topic", detail: "Get a clear explanation with examples" },
  { icon: "◫", title: "Analyze a document", detail: "Find insights in a file or report" }
];

const newConversation = (): Conversation => ({
  id: crypto.randomUUID(), title: "New conversation", model: "openai/gpt-4.1",
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
  const active = conversations.find(c => c.id === activeId) ?? conversations[0];
  const selectedModel = modelOptions.find(m => m.model === active.model) ?? modelOptions[0];
  const grouped = useMemo(() => conversations.filter(c => c.messages.length > 0), [conversations]);

  function updateActive(update: (c: Conversation) => Conversation) {
    setConversations(prev => prev.map(c => c.id === activeId ? update(c) : c));
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
    const userMessage: Message = { id: crypto.randomUUID(), role: "user", content: value };
    const history = [...active.messages, userMessage];
    updateActive(c => ({
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: active.provider,
          model: active.model,
          messages: history.map(({ role, content }) => ({ role, content }))
        })
      });
      const data = await response.json() as { error?: string; content?: string };
      if (!response.ok) throw new Error(data.error || "The model request failed.");
      const assistantMessage: Message = {
        id: crypto.randomUUID(), role: "assistant", content: data.content || "The provider returned an empty response."
      };
      updateActive(c => ({ ...c, messages: [...c.messages, assistantMessage] }));
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
        <button className="nav-item"><Search size={16}/> Search chats</button>
        <div className="sidebar-label">WORKSPACE</div>
        <button className="nav-item active"><MessageSquarePlus size={16}/> Chats</button>
        <button className="nav-item"><Globe2 size={16}/> Explore models <span className="soon">Soon</span></button>
        <div className="history-heading"><span className="sidebar-label">RECENT</span><MoreHorizontal size={16}/></div>
        <div className="history-list">
          {grouped.map(c => <button key={c.id} className={`history-item ${c.id === activeId ? "selected" : ""}`} onClick={() => setActiveId(c.id)}>{c.title}</button>)}
          {grouped.length === 0 && <div className="empty-history">Your conversations will appear here.</div>}
        </div>
        <div className="sidebar-bottom">
          <button className="nav-item"><Settings2 size={16}/> Settings</button>
          <div className="profile-row"><div className="avatar">N</div><div><strong>Newchat user</strong><small>Personal workspace</small></div><MoreHorizontal size={17}/></div>
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
                  {m.model === active.model && <Check size={15}/>}
                </button>)}
              </div>}
            </div>
          </div>
          <div className="topbar-actions"><span className="connection-pill"><span/> Providers not configured</span><button className="icon-button" aria-label="Help"><CircleHelp size={18}/></button></div>
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
    </div>
  );
}
