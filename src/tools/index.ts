import type { ToolSchema } from "../model.ts";
import { bash } from "./bash.ts";
import { edit } from "./edit.ts";
import { read } from "./read.ts";
import { search } from "./search.ts";
import type { Tool } from "./types.ts";
import { write } from "./write.ts";

export const TOOLS: Tool[] = [read, edit, write, bash, search];

export const toolSchemas = (tools: Tool[]): ToolSchema[] =>
  tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
