// Hooks: commands of the user's own that run at fixed points. Each gets the event as JSON
// on stdin. Exit 0 lets things go on (and for some events its output is passed to the
// model); exit 2 blocks, with stderr as the reason; any other exit is the hook's own
// failure, which is shown and otherwise ignored.
import { spawnSync } from "node:child_process";
import type { Layer } from "./settings.ts";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart";
export const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Stop"];
export type Hook = { event: HookEvent; matcher?: string; command: string; file: string };
export type HookOutcome = { blocked: string | null; output: string; failures: string[] };

const TIMEOUT_MS = 60_000;
// Claude Code's tool names, so its settings can be copied over as they are.
const ALIASES: Record<string, string> = { grep: "search", glob: "search", multiedit: "edit" };

// Reads `hooks` from settings: { Event: [{ matcher?, command }] }, or Claude Code's
// { Event: [{ matcher?, hooks: [{ type: "command", command }] }] }.
export function loadHooks(layers: Layer[]): Hook[] {
  const out: Hook[] = [];
  for (const layer of layers) {
    const all = (layer.settings as { hooks?: Record<string, unknown> }).hooks ?? {};
    for (const event of HOOK_EVENTS)
      for (const entry of (Array.isArray(all[event]) ? all[event] : []) as { matcher?: string; command?: string; hooks?: { command?: string }[] }[]) {
        const commands = [entry.command, ...(entry.hooks ?? []).map((h) => h.command)].filter((c): c is string => typeof c === "string" && c.trim() !== "");
        for (const command of commands) out.push({ event, matcher: entry.matcher || undefined, command, file: layer.file });
      }
  }
  return out;
}

const matches = (hook: Hook, tool?: string) => {
  if (!hook.matcher || hook.matcher === "*" || !tool) return true;
  const names = hook.matcher.toLowerCase().split("|").map((n) => ALIASES[n.trim()] ?? n.trim());
  return names.includes(tool);
};

export function runHooks(hooks: Hook[], event: HookEvent, payload: Record<string, unknown>, cwd: string): HookOutcome {
  const outcome: HookOutcome = { blocked: null, output: "", failures: [] };
  for (const hook of hooks) {
    if (hook.event !== event || !matches(hook, payload.tool as string | undefined)) continue;
    const r = spawnSync("/bin/bash", ["-c", hook.command], { cwd, input: JSON.stringify({ event, cwd, ...payload }), encoding: "utf8", timeout: TIMEOUT_MS });
    if (r.status === 0) outcome.output += r.stdout;
    else if (r.status === 2) {
      outcome.blocked = (r.stderr || r.stdout).trim() || "no reason given";
      break;
    } else outcome.failures.push(r.error ? `A ${event} hook could not run (${r.error.message}): ${hook.command}` : `A ${event} hook exited with code ${r.status}: ${hook.command}`);
  }
  outcome.output = outcome.output.trim();
  return outcome;
}
