// Slash commands the user wrote: a markdown file per command, whose text is sent as the
// message. Read from ~/.heyho/commands, then the project's .claude/commands and
// .heyho/commands; a later folder's file replaces an earlier one of the same name.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { heyhoHome } from "./settings.ts";

export type CustomCommand = { name: string; description: string; body: string; file: string };

export function loadCommands(root: string): CustomCommand[] {
  const found = new Map<string, CustomCommand>();
  for (const dir of [join(heyhoHome(), "commands"), join(root, ".claude", "commands"), join(root, ".heyho", "commands")]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).filter((n) => n.endsWith(".md")).sort()) {
      const file = join(dir, name);
      const text = readFileSync(file, "utf8");
      const front = text.match(/^---\n([\s\S]*?)\n---\n?/);
      const body = (front ? text.slice(front[0].length) : text).trim();
      const description = front?.[1].match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, "") ?? body.split("\n")[0].slice(0, 60);
      found.set(name.slice(0, -3), { name: name.slice(0, -3), description, body, file });
    }
  }
  return [...found.values()];
}

// $ARGUMENTS is replaced by what was typed after the command; with no placeholder, the
// arguments are added at the end.
export function expand(command: CustomCommand, args: string): string {
  if (command.body.includes("$ARGUMENTS")) return command.body.replaceAll("$ARGUMENTS", args);
  return args ? `${command.body}\n\n${args}` : command.body;
}
