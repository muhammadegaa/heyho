import { chat, ContextOverflowError, type Message, type Profile, type Reply, type ToolCall, type Usage } from "./model.ts";
import { LoopGuard, normalizeArgs, parseArgs, textToolCalls, toolName } from "./recover.ts";
import { toolSchemas } from "./tools/index.ts";
import { fail, type Tool, type ToolContext, type ToolResult } from "./tools/types.ts";

export type AgentEvent =
  | { type: "request"; step: number } // sent to the model, nothing back yet
  | { type: "thinking"; text: string }
  | { type: "calling"; name: string; argChars: number }
  | { type: "retry"; reason: string }
  // `sub` marks a call made by a subagent, shown under the agent call that started it.
  | { type: "tool_start"; name: string; args: Record<string, unknown>; sub?: boolean }
  | { type: "text"; text: string }
  | { type: "turn"; step: number; usage: Usage; ms: number }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: ToolResult; sub?: boolean };

export type Stats = {
  steps: number;
  toolCalls: Record<string, number>;
  toolErrors: number;
  failedEdits: number;
  repairedArgs: number;
  textToolCalls: number;
  cutoffs: number;
  turns: Usage[];
};

export const newStats = (): Stats => ({ steps: 0, toolCalls: {}, toolErrors: 0, failedEdits: 0, repairedArgs: 0, textToolCalls: 0, cutoffs: 0, turns: [] });

export type RunOptions = {
  profile: Profile;
  messages: Message[]; // appended to, never rewritten: the server reuses its cache for the unchanged prefix
  tools: Tool[];
  ctx: ToolContext;
  maxSteps: number;
  contextSize: number;
  stats: Stats;
  onEvent: (e: AgentEvent) => void;
  record: (m: Message | { usage: Usage }) => void;
  signal?: AbortSignal;
  // The user's hooks around a tool call: `before` returns a reason to block it, `after` a message to add to its result.
  hooks?: { before: (name: string, args: Record<string, unknown>) => string | null; after: (name: string, args: Record<string, unknown>, result: ToolResult) => string | null };
};

export type RunResult = { status: "done" | "step_limit" | "stopped" | "interrupted" | "context_full"; reason?: string };

const IDENTICAL_WARN = 3;
const IDENTICAL_STOP = 5;
const MISTAKE_STOP = 6;
const CUTOFF_STOP = 2;

const CUTOFF_RESULT =
  "Not executed: your reply hit the output token limit, so the arguments may be cut off. Reissue the call with smaller arguments (write a large file in parts: create it, then add to it with edit).";

export async function runAgent(o: RunOptions): Promise<RunResult> {
  const schemas = toolSchemas(o.tools);
  const guard = new LoopGuard();
  const push = (m: Message) => {
    o.messages.push(m);
    o.record(m);
  };
  let mistakes = 0;
  let cutoffs = 0;
  let thoughtOut = false; // the last reply was all thinking and hit the limit: the next one goes without

  for (let step = 1; step <= o.maxSteps; step++) {
    if (o.signal?.aborted) return { status: "interrupted" };
    const t0 = Date.now();
    let reply: Reply;
    try {
      o.onEvent({ type: "request", step });
      reply = await chat(o.profile, o.messages, schemas, { ...streamEvents(o), signal: o.signal, think: thoughtOut ? false : undefined });
      thoughtOut = false;
    } catch (e) {
      if (e instanceof ContextOverflowError) return { status: "context_full", reason: e.message };
      throw e;
    }
    o.stats.steps = step;
    o.stats.turns.push(reply.usage);
    o.record({ usage: reply.usage });
    o.onEvent({ type: "turn", step, usage: reply.usage, ms: Date.now() - t0 });

    let calls = reply.message.tool_calls ?? [];
    const found = !calls.length && reply.finish !== "length" ? textToolCalls(reply.message.content) : null;
    if (found) {
      // Stored as a real tool call so later turns show the model the format it should use.
      o.stats.textToolCalls++;
      calls = found.calls.map((c, i) => ({ id: `text_${step}_${i}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }));
      reply.message.content = found.rest || null;
      reply.message.tool_calls = calls;
    }
    const parsed = calls.map((c) => parseArgs(c.function.arguments));
    // The server re-renders earlier turns from these fields; arguments that aren't valid
    // JSON can make the chat template fail, so store a parseable form.
    calls.forEach((c, i) => {
      const p = parsed[i];
      if (typeof p === "string") c.function.arguments = "{}";
      else if (p.repaired || !c.function.arguments.trim()) c.function.arguments = JSON.stringify(p.args);
    });
    // A reply that ran out of room while still thinking has nothing to keep: replaying the
    // thinking would fill the context with it and invite the same again.
    const allThinking = reply.finish === "length" && !calls.length && !reply.message.content?.trim();
    if (allThinking) reply.message = { role: "assistant", content: "(I thought until the reply ran out of room and wrote no answer.)" };
    push(reply.message);

    if (reply.finish === "length") {
      o.stats.cutoffs++;
      for (const c of calls) push({ role: "tool", tool_call_id: c.id, content: CUTOFF_RESULT });
      if (++cutoffs >= CUTOFF_STOP) return { status: "stopped", reason: "the model's reply hit the output token limit twice in a row" };
      thoughtOut = allThinking;
      if (allThinking) push({ role: "user", content: "You spent the whole reply thinking and wrote nothing. Do not work it all out again: answer now, briefly, from what you already know, or make one tool call." });
      else if (!calls.length) push({ role: "user", content: "Your reply was cut off by the output token limit. Continue from where you stopped, in smaller pieces." });
      continue;
    }
    cutoffs = 0;

    if (!calls.length) return { status: "done" };

    let failed = 0;
    let stopReason = "";
    for (const [i, call] of calls.entries()) {
      if (o.signal?.aborted) {
        push({ role: "tool", tool_call_id: call.id, content: "Interrupted by the user before this call ran." });
        continue;
      }
      const { name, args, result } = await runCall(call, parsed[i], o, guard);
      if (!result.ok) {
        failed++;
        o.stats.toolErrors++;
        if (name === "edit") o.stats.failedEdits++;
      }
      o.onEvent({ type: "tool", name, args, result });
      push({ role: "tool", tool_call_id: call.id, content: result.text });
      if (result.text.startsWith("[stopped]")) stopReason = `the same ${name} call was repeated ${IDENTICAL_STOP} times in a row`;
    }
    if (o.signal?.aborted) return { status: "interrupted" };
    if (stopReason) return { status: "stopped", reason: stopReason };
    mistakes = failed === calls.length ? mistakes + 1 : 0;
    if (mistakes >= MISTAKE_STOP) return { status: "stopped", reason: `every tool call failed for ${MISTAKE_STOP} turns in a row` };

    const last = reply.usage;
    if (last.prompt + last.completion > 0.85 * o.contextSize)
      return { status: "context_full", reason: `${last.prompt + last.completion} of ${o.contextSize} tokens used` };
  }

  push({ role: "user", content: "You have reached the step limit. Do not call any tools. Reply with what you changed, what is left to do, and the current state." });
  o.onEvent({ type: "request", step: o.maxSteps + 1 });
  // Not streamed: some models answer with another tool call written as text, which is cut out here.
  const wrap = await chat(o.profile, o.messages, schemas, { toolChoice: "none", ...streamEvents(o), onText: undefined, signal: o.signal, think: false });
  o.stats.turns.push(wrap.usage);
  const tried = textToolCalls(wrap.message.content);
  const summary = (tried ? tried.rest : wrap.message.content ?? "").trim() || "No summary: at the step limit the model tried to call another tool instead of saying what is left.";
  o.onEvent({ type: "text", text: summary });
  push({ role: "assistant", content: summary });
  return { status: "step_limit" };
}

const streamEvents = (o: RunOptions) => ({
  onText: (text: string) => o.onEvent({ type: "text", text }),
  onReasoning: (text: string) => o.onEvent({ type: "thinking", text }),
  onCall: (name: string, argChars: number) => o.onEvent({ type: "calling", name, argChars }),
  onRetry: (reason: string) => o.onEvent({ type: "retry", reason }),
});

async function runCall(
  call: ToolCall,
  parsed: ReturnType<typeof parseArgs>,
  o: RunOptions,
  guard: LoopGuard,
): Promise<{ name: string; args: Record<string, unknown>; result: ToolResult }> {
  const name = toolName(call.function.name);
  o.stats.toolCalls[name] = (o.stats.toolCalls[name] ?? 0) + 1;
  const tool = o.tools.find((t) => t.name === name);
  if (!tool) return { name, args: {}, result: fail(`Unknown tool "${call.function.name}". Available tools: ${o.tools.map((t) => t.name).join(", ")}.`) };
  if (typeof parsed === "string") return { name, args: {}, result: fail(parsed) };
  if (parsed.repaired) o.stats.repairedArgs++;
  const args = normalizeArgs(tool, parsed.args);
  if (typeof args === "string") return { name, args: parsed.args, result: fail(args) };

  const repeats = guard.see(name, args);
  if (repeats >= IDENTICAL_STOP) return { name, args, result: fail(`[stopped] This exact call was made ${repeats} times in a row.`) };
  let result: ToolResult;
  o.onEvent({ type: "tool_start", name, args });
  const blocked = o.hooks?.before(name, args) ?? null;
  if (blocked !== null) return { name, args, result: fail(`Not run: a hook the user set up blocked it: ${blocked}`) };
  try {
    result = await tool.run(args, o.ctx);
  } catch (e) {
    result = fail((e as Error).message);
  }
  const reported = o.hooks?.after(name, args, result) ?? null;
  if (reported !== null) result = { ...result, text: `${result.text}\n\nA hook reported: ${reported}` };
  if (repeats >= IDENTICAL_WARN)
    result = { ...result, text: result.text + `\n\nYou have made this exact call ${repeats} times in a row. It will not give a different result; try something else.` };
  return { name, args, result };
}
