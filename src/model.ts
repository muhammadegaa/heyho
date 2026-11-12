export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type AssistantMessage = { role: "assistant"; content: string | null; reasoning_content?: string; tool_calls?: ToolCall[] };
export type Message =
  | { role: "system" | "user"; content: string }
  | AssistantMessage
  | { role: "tool"; tool_call_id: string; content: string };

export type ToolSchema = { type: "function"; function: { name: string; description: string; parameters: object } };

export type Profile = {
  baseUrl: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
  sampling?: Record<string, unknown>;
};

export type Usage = { prompt: number; cached: number; completion: number; prefillMs?: number; genTps?: number };
export type Reply = { message: AssistantMessage; finish: string; usage: Usage };

export type ChatOpts = {
  toolChoice?: "auto" | "none";
  onText?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onCall?: (name: string, argChars: number) => void; // a tool call is being written
  onRetry?: (reason: string) => void;
  signal?: AbortSignal;
};

const FIRST_BYTE_MS = 600_000;
const IDLE_MS = 120_000;
const RETRIES = 3;

export async function chat(p: Profile, messages: Message[], tools: ToolSchema[], opts: ChatOpts = {}): Promise<Reply> {
  const body = JSON.stringify({
    model: p.model,
    messages,
    tools,
    tool_choice: opts.toolChoice ?? "auto",
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: p.maxTokens,
    ...p.sampling,
  });
  for (let attempt = 0; ; attempt++) {
    try {
      return await request(p, body, opts);
    } catch (e) {
      if (opts.signal?.aborted || !(e instanceof RetryableError) || attempt >= RETRIES) throw e;
      opts.onRetry?.(e.message);
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
  }
}

export class RetryableError extends Error {}
export class ContextOverflowError extends Error {}

async function request(p: Profile, body: string, opts: ChatOpts): Promise<Reply> {
  const ctrl = new AbortController();
  const abort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", abort);
  let timedOut = false;
  const expire = () => {
    timedOut = true;
    ctrl.abort();
  };
  let timer = setTimeout(expire, FIRST_BYTE_MS);
  try {
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      // A server still busy after this long would be just as slow on a retry.
      if (timedOut) throw new Error(`no response from the server within ${FIRST_BYTE_MS / 1000} s`);
      throw new RetryableError(`connection failed: ${(e as Error).message}`);
    }
    if (!res.ok) {
      const text = await res.text();
      if (/context|n_ctx|too long|exceed/i.test(text) && res.status === 400) throw new ContextOverflowError(text.slice(0, 500));
      const err = `server returned ${res.status}: ${text.slice(0, 500)}`;
      throw res.status >= 500 || res.status === 429 ? new RetryableError(err) : new Error(err);
    }

    let content = "";
    let reasoning = "";
    let finish = "";
    const calls: ToolCall[] = [];
    const usage: Usage = { prompt: 0, cached: 0, completion: 0 };
    let buf = "";
    const decoder = new TextDecoder();
    const reader = res.body!.getReader();

    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (opts.signal?.aborted) throw e;
        throw new RetryableError(timedOut ? `no data from the server for ${IDLE_MS / 1000} s` : `stream dropped: ${(e as Error).message}`);
      }
      if (chunk.done) break;
      clearTimeout(timer);
      timer = setTimeout(expire, IDLE_MS);
      buf += decoder.decode(chunk.value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        const ev = JSON.parse(data);
        if (ev.error) throw new Error(`server error: ${JSON.stringify(ev.error).slice(0, 500)}`);
        const choice = ev.choices?.[0];
        const d = choice?.delta;
        if (d?.reasoning_content) {
          reasoning += d.reasoning_content;
          opts.onReasoning?.(d.reasoning_content);
        }
        if (d?.content) {
          content += d.content;
          opts.onText?.(d.content);
        }
        for (const tc of d?.tool_calls ?? []) {
          const c = (calls[tc.index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
          if (tc.id) c.id = tc.id;
          if (tc.function?.name) c.function.name += tc.function.name;
          if (tc.function?.arguments) c.function.arguments += tc.function.arguments;
          opts.onCall?.(c.function.name, c.function.arguments.length);
        }
        if (choice?.finish_reason) finish = choice.finish_reason;
        if (ev.usage) {
          usage.prompt = ev.usage.prompt_tokens ?? 0;
          usage.completion = ev.usage.completion_tokens ?? 0;
          usage.cached = ev.usage.prompt_tokens_details?.cached_tokens ?? 0;
        }
        if (ev.timings) {
          usage.cached = ev.timings.cache_n ?? usage.cached;
          usage.prefillMs = ev.timings.prompt_ms;
          usage.genTps = ev.timings.predicted_per_second;
        }
      }
    }
    if (!finish && !content && calls.length === 0) throw new RetryableError("empty response stream");

    const message: AssistantMessage = { role: "assistant", content: content || null };
    // Sent back on later requests: the chat template renders the thinking of every turn since
    // the last user message, so without it the model sees its earlier tool calls with no reasoning.
    if (reasoning) message.reasoning_content = reasoning;
    const toolCalls = calls.filter(Boolean);
    toolCalls.forEach((c, i) => (c.id ||= `call_${Date.now()}_${i}`));
    if (toolCalls.length) message.tool_calls = toolCalls;
    return { message, finish: finish || "stop", usage };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", abort);
  }
}

// Reads the context size the server is actually running with. Server defaults differ
// from the model's trained length (Ollama picks 262k on a 64 GB Mac), so never assume.
export async function probeContext(baseUrl: string): Promise<{ server: string; ctx: number } | null> {
  const origin = new URL(baseUrl).origin;
  const get = async (path: string) => {
    try {
      const r = await fetch(origin + path, { signal: AbortSignal.timeout(5000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const props = await get("/props");
  const n = props?.default_generation_settings?.n_ctx;
  if (n) return { server: "llama-server", ctx: n };
  const ps = await get("/api/ps");
  const loaded = ps?.models?.[0]?.context_length;
  if (loaded) return { server: "ollama", ctx: loaded };
  return null;
}
