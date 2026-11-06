// Eval runner: copies each task into a fresh git repo, runs a harness on it headless,
// then copies in the hidden tests and runs verify.sh.
//
//   bun eval/run.ts --profile qwen3-coder --tasks smoke|all|<id,...> [--runs N] [--harness heyho|pi]
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { PROFILES } from "../src/profiles.ts";
import { seatbeltProfile } from "../src/tools/bash.ts";

const ROOT = resolve(import.meta.dirname, "..");
const WALL_LIMIT_MS = 20 * 60_000;
const VERIFY_LIMIT_MS = 120_000;
const PI_BIN = process.env.PI_BIN ?? join(homedir(), ".heyho/baselines/pi/node_modules/.bin/pi");

const { values: opt } = parseArgs({
  options: {
    profile: { type: "string", default: "qwen3-coder" },
    tasks: { type: "string", default: "smoke" },
    runs: { type: "string", default: "1" },
    harness: { type: "string", default: "heyho" },
    "max-steps": { type: "string", default: "40" },
  },
});

type Task = { id: string; dir: string; meta: { smoke?: boolean; category: string; language: string } };

function loadTasks(): Task[] {
  const dirs = ["tasks", "private"].map((d) => join(ROOT, "eval", d)).filter(existsSync);
  const all = dirs.flatMap((d) =>
    readdirSync(d)
      .filter((id) => existsSync(join(d, id, "meta.json")))
      .map((id) => ({ id, dir: join(d, id), meta: JSON.parse(readFileSync(join(d, id, "meta.json"), "utf8")) })),
  );
  const isPrivate = (t: Task) => t.dir.includes(`${join("eval", "private")}`);
  const profile = PROFILES[opt.profile!];
  if (!profile) throw new Error(`unknown profile ${opt.profile}`);
  // Private tasks never go to a hosted model.
  const allowed = profile.local ? all : all.filter((t) => !isPrivate(t));
  if (opt.tasks === "all") return allowed;
  if (opt.tasks === "smoke") return allowed.filter((t) => t.meta.smoke);
  const ids = opt.tasks!.split(",");
  return allowed.filter((t) => ids.includes(t.id));
}

function sh(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

function runWithLimit(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, limitMs: number, logFile: string) {
  return new Promise<{ code: number | null; timedOut: boolean; out: string }>((done) => {
    const child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {}
    }, limitMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      writeFileSync(logFile, out);
      done({ code, timedOut, out });
    });
  });
}

function piModelsJson(): string {
  const p = PROFILES[opt.profile!];
  return JSON.stringify({
    providers: {
      heyho: {
        baseUrl: p.baseUrl,
        api: "openai-completions",
        apiKey: p.apiKeyEnv ? `$${p.apiKeyEnv}` : "none",
        models: [
          {
            id: p.model,
            contextWindow: 65536,
            maxTokens: p.maxTokens,
            samplingParams: p.sampling ?? {},
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  });
}

// Pi --mode json events → the same stats heyho reports.
function piStats(events: string) {
  const stats = { steps: 0, toolCalls: {} as Record<string, number>, toolErrors: 0, turns: [] as { prompt: number; cached: number; completion: number }[] };
  for (const line of events.split("\n")) {
    if (!line.startsWith("{")) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type === "turn_start") stats.steps++;
    if (e.type === "tool_execution_end") {
      stats.toolCalls[e.toolName] = (stats.toolCalls[e.toolName] ?? 0) + 1;
      if (e.isError) stats.toolErrors++;
    }
    if (e.type === "message_end" && e.message?.role === "assistant" && e.message.usage) {
      const u = e.message.usage;
      stats.turns.push({ prompt: (u.input ?? 0) + (u.cacheRead ?? 0), cached: u.cacheRead ?? 0, completion: u.output ?? 0 });
    }
  }
  return stats;
}

async function runOne(task: Task, n: number, outDir: string) {
  const ws = mkdtempSync(join(tmpdir(), `heyho-eval-${task.id}-`));
  cpSync(join(task.dir, "repo"), ws, { recursive: true });
  sh("git", ["init", "-q"], ws);
  sh("git", ["add", "-A"], ws);
  sh("git", ["-c", "user.name=eval", "-c", "user.email=eval@localhost", "commit", "-qm", "init"], ws);
  const prompt = readFileSync(join(task.dir, "task.md"), "utf8").trim();
  const tag = `${task.id}-${n}`;
  const t0 = Date.now();

  let status = "";
  let stats: Record<string, unknown> & { turns?: { prompt: number; cached: number; completion: number }[] } = {};
  if (opt.harness === "heyho") {
    const report = join(outDir, `${tag}.report.json`);
    const r = await runWithLimit(
      "bun",
      [join(ROOT, "src/cli.ts"), "--cwd", ws, "--yolo", "--profile", opt.profile!, "--max-steps", opt["max-steps"]!, "--report", report, prompt],
      ws,
      process.env,
      WALL_LIMIT_MS,
      join(outDir, `${tag}.log`),
    );
    if (existsSync(report)) {
      const rep = JSON.parse(readFileSync(report, "utf8"));
      status = rep.status;
      stats = rep.stats;
    } else status = r.timedOut ? "wall_limit" : `crash(${r.code})`;
    if (r.timedOut) status = "wall_limit";
  } else if (opt.harness === "pi") {
    const agentDir = mkdtempSync(join(tmpdir(), "heyho-pi-"));
    writeFileSync(join(agentDir, "models.json"), piModelsJson());
    // Pi has no sandbox of its own; run it under the same Seatbelt profile heyho uses.
    // --no-skills: Pi otherwise loads every skill in ~/.agents/skills on this machine,
    // which added ~19k tokens to each request in the first baseline.
    const r = await runWithLimit(
      "/usr/bin/sandbox-exec",
      ["-p", seatbeltProfile(ws, false), PI_BIN, "--mode", "json", "--no-session", "--no-skills", "--provider", "heyho", "--model", PROFILES[opt.profile!].model, prompt],
      ws,
      { ...process.env, PI_CODING_AGENT_DIR: agentDir },
      WALL_LIMIT_MS,
      join(outDir, `${tag}.log`),
    );
    stats = piStats(r.out);
    status = r.timedOut ? "wall_limit" : r.code === 0 ? "done" : `exit(${r.code})`;
  } else throw new Error(`unknown harness ${opt.harness}`);
  const wallMs = Date.now() - t0;

  writeFileSync(join(outDir, `${tag}.diff`), sh("git", ["diff", "HEAD"], ws) + sh("git", ["status", "--short"], ws));
  cpSync(join(task.dir, "hidden"), ws, { recursive: true });
  const v = await runWithLimit("bash", [join(task.dir, "verify.sh")], ws, process.env, VERIFY_LIMIT_MS, join(outDir, `${tag}.verify.txt`));
  const turns = stats.turns ?? [];
  const later = turns.slice(1);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    task: task.id,
    run: n,
    harness: opt.harness,
    profile: opt.profile,
    commit: COMMIT,
    pass: v.code === 0,
    status,
    wallMs,
    steps: stats.steps,
    toolCalls: stats.toolCalls,
    toolErrors: stats.toolErrors,
    failedEdits: stats.failedEdits,
    repairedArgs: stats.repairedArgs,
    textToolCalls: stats.textToolCalls,
    cutoffs: stats.cutoffs,
    promptTokens: sum(turns.map((t) => t.prompt)),
    cachedTokens: sum(turns.map((t) => t.cached)),
    generatedTokens: sum(turns.map((t) => t.completion)),
    cacheRateAfterFirst: sum(later.map((t) => t.prompt)) ? sum(later.map((t) => t.cached)) / sum(later.map((t) => t.prompt)) : null,
    maxPrompt: Math.max(0, ...turns.map((t) => t.prompt)),
  };
}

function previousResults(resultsDir: string, current: string): Map<string, number> {
  const prefix = `-${opt.harness}-${opt.profile}.jsonl`;
  const files = readdirSync(resultsDir).filter((f) => f.endsWith(prefix) && f !== current).sort();
  const last = files.at(-1);
  const rates = new Map<string, number>();
  if (!last) return rates;
  const rows = readFileSync(join(resultsDir, last), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  for (const id of new Set(rows.map((r) => r.task))) {
    const rs = rows.filter((r) => r.task === id);
    rates.set(id, rs.filter((r) => r.pass).length / rs.length);
  }
  return rates;
}

// The heyho commit each result was measured on; "+dirty" if src/ had uncommitted changes.
const COMMIT = sh("git", ["rev-parse", "--short", "HEAD"], ROOT).trim() + (sh("git", ["status", "--porcelain", "src"], ROOT).trim() ? "+dirty" : "");
const tasks = loadTasks();
if (!tasks.length) throw new Error(`no tasks match "${opt.tasks}"`);
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const resultsDir = join(ROOT, "eval", "results");
const outDir = join(resultsDir, `${stamp}-${opt.harness}-${opt.profile}`);
mkdirSync(outDir, { recursive: true });
const resultsFile = `${stamp}-${opt.harness}-${opt.profile}.jsonl`;
const prev = previousResults(resultsDir, resultsFile);
const runs = Number(opt.runs) || 1;

console.log(`${opt.harness} · ${opt.profile} · heyho ${COMMIT} · ${tasks.length} tasks × ${runs} runs → eval/results/${resultsFile}`);
const rows = [];
for (const task of tasks)
  for (let n = 1; n <= runs; n++) {
    const row = await runOne(task, n, outDir);
    rows.push(row);
    writeFileSync(join(resultsDir, resultsFile), JSON.stringify(row) + "\n", { flag: "a" });
    const cache = row.cacheRateAfterFirst === null ? "-" : `${Math.round(100 * row.cacheRateAfterFirst)}%`;
    console.log(
      `${row.pass ? "PASS" : "FAIL"}  ${task.id.padEnd(26)} run ${n}  ${row.status.padEnd(11)} ${String(row.steps ?? "-").padStart(3)} steps  ${(row.wallMs / 1000).toFixed(0).padStart(5)} s  cache ${cache}  tool errors ${row.toolErrors ?? "-"}`,
    );
  }

console.log("\ntask                        pass rate   previous");
for (const task of tasks) {
  const rs = rows.filter((r) => r.task === task.id);
  const rate = rs.filter((r) => r.pass).length / rs.length;
  const before = prev.get(task.id);
  console.log(`${task.id.padEnd(28)}${`${rs.filter((r) => r.pass).length}/${rs.length}`.padEnd(12)}${before === undefined ? "-" : `${Math.round(before * 100)}%`}`);
}
const passed = rows.filter((r) => r.pass).length;
console.log(`\ntotal ${passed}/${rows.length} · wall ${(rows.reduce((a, r) => a + r.wallMs, 0) / 60000).toFixed(1)} min`);
