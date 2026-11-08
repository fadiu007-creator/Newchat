export interface Env {
  ASSETS: Fetcher;
  OPENROUTER_API_KEY?: string;
  OPENAI_API_KEY?: string;
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  ALLOWED_ORIGIN?: string;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type ChatRequest = { provider: "openrouter" | "openai"; model: string; messages: ChatMessage[] };

const json = (data: unknown, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization"
    }
  });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const origin = env.ALLOWED_ORIGIN || request.headers.get("Origin") || "*";
    if (request.method === "OPTIONS") return new Response(null, {
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization"
      }
    });
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
    if (url.pathname === "/api/health") return json({ ok: true, service: "newchat-api" }, 200, origin);
    if (url.pathname !== "/api/chat" || request.method !== "POST") return json({ error: "Not found" }, 404, origin);

    let body: ChatRequest;
    try { body = await request.json() as ChatRequest; }
    catch { return json({ error: "Invalid JSON body." }, 400, origin); }

    if (!body || !["openrouter", "openai"].includes(body.provider) ||
        typeof body.model !== "string" || body.model.length > 160 ||
        !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 80) {
      return json({ error: "Invalid chat request." }, 400, origin);
    }
    const validMessages = body.messages.every(m =>
      m && ["system", "user", "assistant"].includes(m.role) &&
      typeof m.content === "string" && m.content.length <= 30000
    );
    if (!validMessages) return json({ error: "Invalid message format." }, 400, origin);

    const bearer = request.headers.get("Authorization") || "";
    const accessToken = bearer.startsWith("Bearer ") ? bearer.slice(7) : "";
    if (!accessToken || !env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      return json({ error: "Authentication is required. Configure Supabase and sign in." }, 401, origin);
    }
    try {
      const authResponse = await fetch(`${env.SUPABASE_URL.replace(/\\/$/, "")}/auth/v1/user`, {
        headers: { "apikey": env.SUPABASE_ANON_KEY, "Authorization": `Bearer ${accessToken}` }
      });
      if (!authResponse.ok) return json({ error: "Your session is invalid or expired. Please sign in again." }, 401, origin);
    } catch {
      return json({ error: "Unable to verify your session. Please try again." }, 502, origin);
    }

    const isOpenAI = body.provider === "openai";
    const apiKey = isOpenAI ? env.OPENAI_API_KEY : env.OPENROUTER_API_KEY;
    if (!apiKey) return json({
      error: `${isOpenAI ? "OpenAI" : "OpenRouter"} API key is not configured on the server. Add the corresponding Cloudflare Worker secret.`
    }, 503, origin);

    const endpoint = isOpenAI
      ? "https://api.openai.com/v1/chat/completions"
      : "https://openrouter.ai/api/v1/chat/completions";
    const headers: Record<string, string> = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };
    if (!isOpenAI) {
      headers["HTTP-Referer"] = "https://newchat.app";
      headers["X-Title"] = "Newchat";
    }

    try {
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: body.model, messages: body.messages, stream: false })
      });
      const result = await upstream.json() as {
        error?: { message?: string } | string;
        choices?: Array<{ message?: { content?: string | Array<{ type: string; text?: string }> } }>;
      };
      if (!upstream.ok) {
        const detail = typeof result.error === "string" ? result.error : result.error?.message;
        return json({ error: detail || `Provider request failed (${upstream.status}).` }, upstream.status, origin);
      }
      const content = result.choices?.[0]?.message?.content;
      const normalized = Array.isArray(content)
        ? content.map(part => part.text || "").join("")
        : content;
      if (typeof normalized !== "string") return json({ error: "Provider returned an unsupported response format." }, 502, origin);
      return json({ content: normalized }, 200, origin);
    } catch {
      return json({ error: "Unable to connect to the AI provider. Please try again." }, 502, origin);
    }
  }
};
