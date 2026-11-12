// Replaces a long conversation with the system prompt plus a summary written by the model.
import { chat, type ChatOpts, type Message, type Profile, type ToolSchema } from "./model.ts";

const ASK = `The conversation is about to be shortened to free context. Write the notes you will need to carry on, as plain text with no tool calls:
- the user's request and any instructions they gave along the way
- what has been done so far, naming each file changed and what changed in it
- what was learned about the code that matters for the rest (paths, function names, commands that work)
- what is left to do, in order
Be specific and brief. Do not repeat file contents.`;

export async function compact(profile: Profile, messages: Message[], schemas: ToolSchema[], opts: ChatOpts = {}): Promise<Message[]> {
  // Same prefix and tool schemas as the session, so the server reuses its cache for this request.
  const reply = await chat(profile, [...messages, { role: "user", content: ASK }], schemas, { ...opts, toolChoice: "none" });
  const summary = reply.message.content?.trim();
  if (!summary) throw new Error("the model returned an empty summary");
  return [messages[0], { role: "user", content: `Earlier messages in this session were removed to free context. Your notes from before:\n\n${summary}` }];
}
