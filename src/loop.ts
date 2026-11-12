import { chat, ContextOverflowError, type Message, type Profile, type Reply, type ToolCall, type Usage } from "./model.ts";
import { LoopGuard, normalizeArgs, parseArgs, textToolCalls, toolName } from "./recover.ts";
import { toolSchemas } from "./tools/index.ts";
import { fail, type Tool, type ToolContext, type ToolResult } from "./tools/types.ts";

export type AgentEvent =
  | { type: "request"; step: number } // sent to the model, nothing back yet
  | { type: "thinking"; text: string }
  | { type: "calling"; name: string; argChars: number }
  | { type: "retry"; reason: string }
  | { type: "tool_start"; name: string; args: Record<string, unknown> }
  | { type: "text"; text: string }
  | { type: "turn"; step: number; usage: Usage; ms: number }
  | { type: "tool"; name: string; args: Record<string, unknown>; result: ToolResult };

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

  for (let step = 1; step <= o.maxSteps; step++) {
    if (o.signal?.aborted) return { status: "interrupted" };
    const t0 = Date.now();
    let reply: Reply;
    try {
      o.onEvent({ type: "request", step });
      reply = await chat(o.profile, o.messages, schemas, { ...streamEvents(o), signal: o.signal });
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
    push(reply.message);

    if (reply.finish === "length") {
      o.stats.cutoffs++;
      for (const c of calls) push({ role: "tool", tool_call_id: c.id, content: CUTOFF_RESULT });
      if (++cutoffs >= CUTOFF_STOP) return { status: "stopped", reason: "the model's reply hit the output token limit twice in a row" };
      if (!calls.length) push({ role: "user", content: "Your reply was cut off by the output token limit. Continue from where you stopped, in smaller pieces." });
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
  const wrap = await chat(o.profile, o.messages, schemas, { toolChoice: "none", ...streamEvents(o), signal: o.signal });
  o.stats.turns.push(wrap.usage);
  push({ role: "assistant", content: wrap.message.content });
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
  try {
    result = await tool.run(args, o.ctx);
  } catch (e) {
    result = fail((e as Error).message);
  }
  if (repeats >= IDENTICAL_WARN)
    result = { ...result, text: result.text + `\n\nYou have made this exact call ${repeats} times in a row. It will not give a different result; try something else.` };
  return { name, args, result };
}
