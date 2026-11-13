import { fail, ok, type Tool } from "./types.ts";

export const ask: Tool = {
  name: "ask",
  description: "Ask the user when the request is ambiguous in a way that changes the result.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string" },
      options: { type: "array", items: { type: "string" } },
    },
    required: ["question"],
  },
  async run(args, ctx) {
    const question = String(args.question ?? "").trim();
    if (!question) return fail("question is empty.");
    const options = Array.isArray(args.options) ? args.options.map(String).filter(Boolean).slice(0, 6) : [];
    const answer = ctx.question ? await ctx.question(question, options) : null;
    if (answer === null) return fail("Nobody is here to answer. Choose the most likely reading yourself, and say in your final reply what you assumed.");
    return ok(`The user answered: ${answer}`);
  },
};
