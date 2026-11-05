import type { Profile } from "./model.ts";

type ProfileDef = Profile & { apiKeyEnv?: string; local: boolean };

// Sampling values come from each model card.
export const PROFILES: Record<string, ProfileDef> = {
  "qwen3-coder": {
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen3-coder",
    maxTokens: 8192,
    sampling: { temperature: 0.7, top_p: 0.8, top_k: 20, repeat_penalty: 1.05 },
    local: true,
  },
  "qwen3.6": {
    baseUrl: "http://127.0.0.1:8080/v1",
    model: "qwen3.6",
    maxTokens: 16384,
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
    local: true,
  },
  "or-sonnet": {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "anthropic/claude-sonnet-5.5",
    maxTokens: 16384,
    apiKeyEnv: "OPENROUTER_API_KEY",
    local: false,
  },
  "or-qwen3.6": {
    baseUrl: "https://openrouter.ai/api/v1",
    model: "qwen/qwen3.6-35b-a3b",
    maxTokens: 16384,
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20 },
    apiKeyEnv: "OPENROUTER_API_KEY",
    local: false,
  },
};

export function loadProfile(name: string, overrides: { baseUrl?: string; model?: string }): Profile & { local: boolean } {
  const def = PROFILES[name];
  if (!def) throw new Error(`Unknown profile "${name}". Profiles: ${Object.keys(PROFILES).join(", ")}`);
  const apiKey = def.apiKeyEnv ? process.env[def.apiKeyEnv] : process.env.HEYHO_API_KEY;
  if (def.apiKeyEnv && !apiKey) throw new Error(`Profile "${name}" needs ${def.apiKeyEnv} set in the environment.`);
  return { ...def, baseUrl: overrides.baseUrl ?? def.baseUrl, model: overrides.model ?? def.model, apiKey };
}
