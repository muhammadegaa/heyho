import type { ToolSchema } from "../model.ts";
import { ask } from "./ask.ts";
import { bash } from "./bash.ts";
import { edit } from "./edit.ts";
import { fetchTool } from "./fetch.ts";
import { read } from "./read.ts";
import { search } from "./search.ts";
import { todo } from "./todo.ts";
import type { Tool } from "./types.ts";
import { write } from "./write.ts";

// The first five are the core. The rest are optional: each costs prompt tokens on every
// request, so each is kept only while the eval shows it does no harm.
export const CORE: Tool[] = [read, edit, write, bash, search];
export const EXTRA: Tool[] = [todo, ask, fetchTool];
export const TOOLS: Tool[] = [...CORE, ...EXTRA];

export const toolSchemas = (tools: Tool[]): ToolSchema[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
