import { fail, ok, type Todo, type Tool } from "./types.ts";

// The model's own checklist for a task with several steps. It is shown to the user as it
// changes; the reply to the model is short, since the list is already in its own call.
export const todo: Tool = {
  name: "todo",
  description: "Checklist for a multi-step task. Send every item each time, starting with [ ], [~] (doing) or [x].",
  parameters: {
    type: "object",
    properties: { items: { type: "array", items: { type: "string" } } },
    required: ["items"],
  },
  async run(args, ctx) {
    if (!Array.isArray(args.items)) return fail('items must be a list of strings such as "[ ] run the tests".');
    // Objects with text and status are accepted too: some models send them whatever the schema says.
    const items: Todo[] = args.items
      .map((raw: unknown): Todo => {
        if (raw && typeof raw === "object") {
          const o = raw as { text?: unknown; status?: unknown };
          return { text: String(o.text ?? "").trim(), status: o.status === "done" || o.status === "doing" ? o.status : "pending" };
        }
        const m = String(raw).match(/^\s*\[(.?)\]\s*(.*)$/s);
        const mark = m?.[1].toLowerCase();
        return { text: (m ? m[2] : String(raw)).trim(), status: mark === "x" ? "done" : mark === "~" ? "doing" : "pending" };
      })
      .filter((i) => i.text);
    ctx.onTodos?.(items);
    const left = items.filter((i) => i.status !== "done").length;
    return ok(left ? `Checklist saved: ${items.length - left} of ${items.length} done.` : `Checklist saved: all ${items.length} done.`);
  },
};
