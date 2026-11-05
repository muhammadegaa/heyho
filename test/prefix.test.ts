import { expect, test } from "bun:test";
import { chat, probeContext } from "../src/model.ts";
import { systemPrompt } from "../src/prompt.ts";
import { TOOLS, toolSchemas } from "../src/tools/index.ts";

// Measures the fixed prefix (system prompt + tool schemas, as rendered by the server's
// chat template) against a running server. Skipped when no server is up.
const baseUrl = process.env.HEYHO_BASE_URL ?? "http://127.0.0.1:8080/v1";
const live = await probeContext(baseUrl);
const BUDGET = 1500;

test.skipIf(!live)(`fixed prefix is at most ${BUDGET} tokens`, async () => {
  const messages = [
    { role: "system" as const, content: systemPrompt(process.cwd(), new Date("2026-01-01")) },
    { role: "user" as const, content: "hi" },
  ];
  const reply = await chat({ baseUrl, model: "any", maxTokens: 1 }, messages, toolSchemas(TOOLS));
  console.log(`fixed prefix: ${reply.usage.prompt} tokens`);
  expect(reply.usage.prompt).toBeLessThanOrEqual(BUDGET);
}, 120_000);
