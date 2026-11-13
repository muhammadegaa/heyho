// Replaces a long conversation with the system prompt plus a summary written by the model.
import { textToolCalls } from "./recover.ts";
import { chat, ContextOverflowError, type ChatOpts, type Message, type Profile, type ToolSchema } from "./model.ts";

const ASK = `The conversation is about to be shortened to free context. Write the notes you will need to carry on, as plain text with no tool calls:
- the user's request and any instructions they gave along the way
- what has been done so far, naming each file changed and what changed in it
- what was learned about the code that matters for the rest (paths, function names, commands that work)
- what is left to do, in order
Be specific and brief. Do not repeat file contents.`;

export const NOTES_PREFIX = "Earlier messages in this session were removed to free context.";
export const CARRY_ON = "Carry on with the task from where you stopped.";

export async function compact(profile: Profile, messages: Message[], schemas: ToolSchema[], opts: ChatOpts = {}): Promise<Message[]> {
  // Same prefix and tool schemas as the session, so the server reuses its cache for this request.
  // The conversation can already be too big to send, when one step's tool results took it
  // past the limit. Then the tool results are cut, harder each time, until the request fits.
  let reply: Awaited<ReturnType<typeof chat>> | undefined;
  for (const keep of [Infinity, 4000, 1000, 200]) {
    const fitted = messages.map((m) =>
      m.role === "tool" && typeof m.content === "string" && m.content.length > keep ? { ...m, content: `${m.content.slice(0, keep)}\n[cut to make room: ${m.content.length - keep} more characters]` } : m,
    );
    try {
      reply = await chat(profile, [...fitted, { role: "user", content: ASK }], schemas, { ...opts, toolChoice: "none" });
      break;
    } catch (e) {
      if (!(e instanceof ContextOverflowError) || keep === 200) throw e;
    }
  }
  if (!reply) throw new Error("the conversation could not be shortened");
  // Mid-task, a model may answer with its next tool calls written as text. Those are not
  // notes: ask once more, and failing that keep at least what the user asked for.
  const notes = (r: typeof reply) => (textToolCalls(r.message.content)?.rest ?? r.message.content ?? "").trim();
  let summary = notes(reply);
  if (summary.length < 20 && textToolCalls(reply.message.content)) {
    const again = await chat(profile, [{ role: "system", content: "You write short plain-text notes. You have no tools." }, { role: "user", content: `${transcriptTail(messages)}\n\n${ASK}` }], [], opts);
    summary = notes(again);
    if (summary.length < 20) summary = `(No notes were written.) What the user asked for, in order:\n${asked(messages).map((t) => `- ${t}`).join("\n")}`;
  }
  if (!summary) throw new Error("the model returned an empty summary");
  return [messages[0], { role: "user", content: `${NOTES_PREFIX} Your notes from before:\n\n${summary}` }];
}

// What the user typed, leaving out the messages heyho writes itself.
const asked = (messages: Message[]) =>
  messages.filter((m) => m.role === "user" && typeof m.content === "string" && !m.content.startsWith(NOTES_PREFIX) && m.content !== CARRY_ON && !m.content.startsWith("[")).map((m) => (m.content as string).slice(0, 600));

// The user's requests and the model's own words from the end of the conversation, as plain
// text short enough to send without the tool schemas.
function transcriptTail(messages: Message[]): string {
  const said = messages.filter((m) => m.role === "assistant" && typeof m.content === "string" && m.content.trim()).slice(-8).map((m) => `You said: ${(m.content as string).slice(0, 800)}`);
  const calls = messages.flatMap((m) => (m.role === "assistant" ? m.tool_calls ?? [] : [])).slice(-40).map((c) => `${c.function.name} ${c.function.arguments.slice(0, 120)}`);
  return [`The user asked:\n${asked(messages).join("\n")}`, said.join("\n"), calls.length ? `Your last tool calls:\n${calls.join("\n")}` : ""].filter(Boolean).join("\n\n");
}
