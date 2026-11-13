// Settings files, lowest priority first: ~/.heyho/settings.json (you, everywhere),
// <project>/.heyho/settings.json (the project, shared), <project>/.heyho/settings.local.json
// (you, this project). Later files override earlier ones; permission rules from all three apply.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const heyhoHome = () => process.env.HEYHO_HOME ?? join(homedir(), ".heyho");

export type Source = "user" | "project" | "local" | "saved" | "session";
export type RuleList = { allow?: string[]; ask?: string[]; deny?: string[] };
export type Settings = { mode?: string; profile?: string; maxSteps?: number; permissions?: RuleList };
export type Layer = { source: Source; file: string; settings: Settings };

export const settingsFiles = (root: string): [Source, string][] => [
  ["user", join(heyhoHome(), "settings.json")],
  ["project", join(root, ".heyho", "settings.json")],
  ["local", join(root, ".heyho", "settings.local.json")],
];

export function loadSettings(root: string): { merged: Settings; layers: Layer[]; problems: string[] } {
  const layers: Layer[] = [];
  const problems: string[] = [];
  for (const [source, file] of settingsFiles(root)) {
    if (!existsSync(file)) continue;
    try {
      layers.push({ source, file, settings: JSON.parse(readFileSync(file, "utf8")) });
    } catch (e) {
      problems.push(`${file} is not valid JSON and was ignored: ${(e as Error).message}`);
    }
  }
  const merged: Settings = Object.assign({}, ...layers.map((l) => ({ mode: l.settings.mode, profile: l.settings.profile, maxSteps: l.settings.maxSteps })).map((s) => Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined))));
  return { merged, layers, problems };
}
