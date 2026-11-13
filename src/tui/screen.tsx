// The interactive screen: the transcript scrolls above, and below it sit whatever is in
// progress, any question for the user, the input box and a footer.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Box, Static, Text, useApp, useInput, usePaste, useStdout, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { INIT_TASK, type App, type ApprovalAnswer, type ApprovalRequest } from "../app.ts";
import { MODE_HELP, MODES, type Mode } from "../approve.ts";
import { expand, loadCommands } from "../commands.ts";
import { listFiles } from "../input.ts";
import { heyhoHome } from "../settings.ts";
import { ago, sessionPreview, type SessionInfo } from "../session.ts";
import { changeTitle, lightTheme, paint, renderDiff, tidyPaths } from "../ui.ts";
import * as ed from "./edit.ts";
import { normalKey, type VimState } from "./vim.ts";
import { secs, type Store } from "./store.ts";

const p = paint(true);
// The highlight and warning colours, which differ on a light background.
const ACCENT = lightTheme() ? "blue" : "cyan";
const WARN = lightTheme() ? "#af5f00" : "yellow";
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const MENU_ROWS = 8;
const HISTORY_MAX = 500;
const BELL_AFTER_MS = 20_000;
const DOUBLE_PRESS_MS = 600;

export const COMMANDS: [name: string, args: string, help: string][] = [
  ["help", "", "commands and keys"],
  ["context", "", "how much of the model's context is in use"],
  ["compact", "", "shorten the conversation so far to free context"],
  ["clear", "", "start a new conversation (the old one stays under /resume)"],
  ["resume", "", "reopen an earlier session in this folder"],
  ["rewind", "", "go back to an earlier message: files, conversation or both"],
  ["undo", "", "take back the file changes of the last turn that made any"],
  ["diff", "", "show uncommitted changes (git diff)"],
  ["rename", "<name>", "name this session, for /resume and --resume"],
  ["export", "[file]", "write the conversation to a markdown file"],
  ["copy", "", "copy the last reply to the clipboard"],
  ["status", "", "version, model, folder, session"],
  ["tasks", "[stop <n>]", "commands running in the background"],
  ["hooks", "", "your commands that run around tool calls, messages and stops"],
  ["mcp", "", "MCP servers and the tools they offer"],
  ["skills", "", "instructions the model reads when a task calls for them"],
  ["agents", "", "subagents the model can hand work to"],
  ["mode", "[ask|auto|plan|dontask|yolo]", "show or set the mode"],
  ["permissions", "[allow|ask|deny|remove <rule>] [reset]", "rules for what runs without asking, asks, or is refused"],
  ["init", "", "have the model write AGENTS.md for this project"],
  ["memory", "[edit user|project|local|notes]", "the instruction files in effect; edit opens one in $EDITOR"],
  ["model", "[profile]", "show or switch the model profile"],
  ["exit", "", "quit"],
];

const KEYS = `Enter sends · \\ then Enter, Option+Enter or Ctrl+J starts a new line · paste keeps its lines
/ commands · @ files · ! runs a shell command yourself · Up/Down history
Shift+Tab changes mode · Esc stops the model · Esc Esc on an empty line opens rewind
Ctrl+R searches history · Ctrl+G edits the message in $EDITOR · Ctrl+S sets the draft aside and brings it back
Ctrl+O shows the last command's full output · Ctrl+T hides or shows the checklist · Ctrl+L redraws · Ctrl+C twice or Ctrl+D quits`;

const MODE_LABEL: Record<Mode, string> = { ask: "⏸ ask", auto: "⏵⏵ auto", plan: "⏸ plan", dontask: "⏵⏵ dontask", yolo: "⏵⏵ yolo" };
const MODE_SHORT: Record<Mode, string> = { ask: "asks before edits and commands", auto: "edits don't ask", plan: "read-only, proposes a plan", dontask: "refuses what isn't allowed", yolo: "nothing asks, commands sandboxed" };

type Choice<T> = { label: string; hint?: string; value: T };
type Overlay =
  | { type: "resume"; choices: Choice<SessionInfo>[] }
  | { type: "history"; choices: Choice<string>[] }
  | { type: "trust"; choices: Choice<boolean>[] }
  | { type: "rewind"; choices: Choice<number>[] }
  | { type: "rewindWhat"; index: number; choices: Choice<{ code: boolean; conversation: boolean }>[] }
  | { type: "plan"; choices: Choice<"auto" | "ask" | "keep">[] };

function approvalChoices(req: ApprovalRequest): Choice<ApprovalAnswer | "say">[] {
  if (req.kind === "mcp") return [{ label: "Yes", value: "yes" }, { label: `Yes, and don't ask again in this project for the ${req.prefix} server`, value: "prefix" }, { label: "No, and say what to do instead", value: "say" }];
  if (req.kind === "fetch") return [{ label: "Yes", value: "yes" }, { label: `Yes, and don't ask again in this project for pages on ${req.prefix}`, value: "prefix" }, { label: "No, and say what to do instead", value: "say" }];
  const always =
    req.kind !== "bash"
      ? { label: `Yes, and don't ask again for ${req.kind === "edit" ? "edits" : "new files"} this session`, value: "always" as const }
      : req.prefix
        ? { label: `Yes, and don't ask again in this project for: ${req.prefix}`, value: "prefix" as const }
        : { label: "Yes, and don't ask again in this project for this exact command", value: "always" as const };
  return [{ label: "Yes", value: "yes" }, always, { label: "No, and say what to do instead", value: "say" }];
}

function List<T>({ choices, index, numbered = true }: { choices: Choice<T>[]; index: number; numbered?: boolean }) {
  return (
    <Box flexDirection="column">
      {choices.map((c, i) => (
        <Text key={i} color={i === index ? ACCENT : undefined}>
          {i === index ? "❯ " : "  "}
          {numbered ? `${i + 1}. ` : ""}
          {c.label}
          {c.hint ? <Text dimColor>{`  ${c.hint}`}</Text> : null}
        </Text>
      ))}
    </Box>
  );
}

// One line whatever the width: the right side goes first when there is no room, then the hint is cut.
function Footer({ width, mode, hint, right }: { width: number; mode: Mode; hint: string; right: string }) {
  const label = `  ${MODE_LABEL[mode]}`;
  // The model and context use matter more than the hint, so the hint is cut first.
  const showRight = label.length + 2 + right.length + 1 <= width;
  const room = width - label.length - 3 - (showRight ? right.length + 3 : 0);
  const shown = hint.length <= room ? hint : room > 8 ? hint.slice(0, room - 1) + "…" : "";
  return (
    <Box justifyContent="space-between" width={width}>
      <Text color={mode === "ask" ? undefined : mode === "plan" ? "blue" : WARN} wrap="truncate-end">
        {label}
        <Text dimColor>{shown ? ` · ${shown}` : ""}</Text>
      </Text>
      {showRight ? <Text dimColor>{`${right} `}</Text> : null}
    </Box>
  );
}

const Rule = ({ width }: { width: number }) => <Text dimColor>{"─".repeat(Math.max(10, width))}</Text>;

// The text with the cursor drawn in it. An empty box shows a hint instead.
function InputText({ edit, active, hint }: { edit: ed.Edit; active: boolean; hint: string }) {
  if (!edit.value)
    return (
      <Text>
        {active ? "\x1b[7m \x1b[27m" : " "}
        <Text dimColor>{hint}</Text>
      </Text>
    );
  const { value, cursor } = edit;
  const under = value[cursor] === undefined || value[cursor] === "\n" ? " " : value[cursor];
  const after = value[cursor] === "\n" ? value.slice(cursor) : value.slice(cursor + 1);
  return <Text>{value.slice(0, cursor) + (active ? `\x1b[7m${under}\x1b[27m` : under) + after}</Text>;
}

export function Screen({ app, store, version, pickSession }: { app: App; store: Store; version: string; pickSession?: boolean }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const { exit, suspendTerminal } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(20, columns);

  // When the width changes the terminal re-wraps everything already printed, and the rows
  // Ink would erase are no longer where it thinks. So wipe the screen and its scrollback and
  // print the transcript again at the new width. Waits for the drag to settle.
  const { stdout } = useStdout();
  const [printed, setPrinted] = useState(0);
  const lastWidth = useRef(columns);
  useEffect(() => {
    if (columns === lastWidth.current) return;
    const timer = setTimeout(() => {
      lastWidth.current = columns;
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setPrinted((n) => n + 1);
    }, 150);
    return () => clearTimeout(timer);
  }, [columns]);

  const [edit, setEdit] = useState<ed.Edit>(ed.EMPTY);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOff, setMenuOff] = useState(false); // closed with Esc until the text changes
  // The trust question is up from the first frame, so the input box never shows before it.
  const [preview, setPreview] = useState(false); // the session picker is showing what was asked in the highlighted session
  const [overlay, setOverlayRaw] = useState<Overlay | null>(app.needsTrust && !app.trusted ? { type: "trust", choices: [{ label: "Yes, I trust this project: use them", value: true }, { label: "No: leave them off", value: false }] } : null);
  const [filter, setFilter] = useState(""); // typed into a picker that can be searched
  const setOverlay = (o: Overlay | null) => (setFilter(""), setOverlayRaw(o));
  const stash = useRef<string | null>(null);
  const [showTodos, setShowTodos] = useState(true);
  const [vimInsert, setVimInsert] = useState(true); // with vim keys on: typing text, or giving commands
  const vimPending = useRef("");
  const vimKept = useRef<Pick<VimState, "register" | "undo">>({}); // what was last copied, and changes u can take back
  const [statusText, setStatusText] = useState("");

  const [choice, setChoice] = useState(0); // selected row of the approval or overlay list
  const [saying, setSaying] = useState<ed.Edit | null>(null); // typing what to do instead
  const [busy, setBusy] = useState(false);

  // The user's own status line: run after each turn and when the mode changes.
  useEffect(() => {
    if (!app.statusCommand || busy) return;
    const child = spawn("/bin/bash", ["-c", app.statusCommand], { cwd: app.root, stdio: ["pipe", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.on("close", () => setStatusText(out.split("\n")[0].trim().slice(0, 80)));
    child.on("error", () => setStatusText(""));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ model: app.profile.model, cwd: app.root, mode: app.mode, contextUsed: app.contextUsed, contextSize: app.contextSize, session: app.session.file, sessionName: app.name }));
    const timer = setTimeout(() => child.kill(), 3000);
    return () => clearTimeout(timer);
  }, [busy, app.mode, app.name]);
  const [, setTick] = useState(0);
  const refresh = () => setTick((t) => t + 1);
  const lastEsc = useRef(0);
  const lastCtrlC = useRef(0);
  const [exitHint, setExitHint] = useState(false);

  const historyFile = join(app.stateDir, "history.json");
  const history = useRef<string[]>(existsSync(historyFile) ? JSON.parse(readFileSync(historyFile, "utf8")) : []);
  const historyAt = useRef(-1); // -1: not browsing
  const draft = useRef("");
  const files = useRef<string[] | null>(null);
  // A skill can be called by name like a command: its text is sent, with what was typed after it.
  const custom = useMemo(() => {
    const commands = loadCommands(app.root);
    return [...commands, ...app.skills.filter((s) => !commands.some((c) => c.name === s.name)).map((s) => ({ name: s.name, description: s.description, file: s.file, body: `Use the ${s.name} skill.\n\n${s.body}` }))];
  }, []);
  const allCommands: [string, string, string][] = [...COMMANDS, ...custom.filter((c) => !COMMANDS.some((b) => b[0] === c.name)).map((c): [string, string, string] => [c.name, "[arguments]", c.description])];

  const { live } = store;
  const pending = live.pending;

  // Redraw the spinner while something is in progress.
  useEffect(() => {
    if (!live.activity) return;
    const timer = setInterval(refresh, 120);
    return () => clearInterval(timer);
  }, [Boolean(live.activity)]);

  // The most recent message is the likeliest place to go back to.
  useEffect(() => setChoice(overlay?.type === "rewind" ? overlay.choices.length - 1 : 0), [pending, overlay?.type, filter, live.asking]);
  // A question with nothing to choose from goes straight to typing.
  useEffect(() => setSaying(live.asking && !live.asking.options.length ? ed.EMPTY : null), [live.asking]);
  const searchable = overlay?.type === "resume" || overlay?.type === "history";
  const shownChoices: Choice<unknown>[] | null = overlay
    ? searchable
      ? (overlay.choices as Choice<unknown>[]).filter((c) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(filter.toLowerCase())).slice(0, 10)
      : (overlay.choices as Choice<unknown>[])
    : null;
  const openResume = () => {
    const list = app.sessions();
    if (!list.length) return store.note("No earlier sessions in this folder.", "dim");
    setOverlay({ type: "resume", choices: list.map((s) => ({ label: s.first, hint: `${ago(s.when)} · ${s.turns} message${s.turns > 1 ? "s" : ""}`, value: s })) });
  };
  useEffect(() => {
    if (pickSession && !(app.needsTrust && !app.trusted)) openResume();
  }, []);
  useEffect(() => {
    if (pending && app.runningFor > BELL_AFTER_MS) process.stderr.write("\x07");
  }, [pending]);

  // ---- menus that follow what is typed ----
  const slashQuery = !edit.value.includes("\n") && /^\/\S*$/.test(edit.value) ? edit.value.slice(1) : null;
  const token = slashQuery === null ? ed.atToken(edit) : null;
  const menu = useMemo(() => {
    if (menuOff) return null;
    if (slashQuery !== null) {
      const names = ed.rank(allCommands.map((c) => c[0]), slashQuery, MENU_ROWS);
      return { kind: "slash" as const, rows: names.map((n) => ({ text: "/" + n, hint: allCommands.find((c) => c[0] === n)![2] })) };
    }
    if (token) {
      files.current ??= listFiles(app.root);
      return { kind: "file" as const, rows: ed.rank(files.current, token.query, MENU_ROWS).map((f) => ({ text: f, hint: "" })) };
    }
    return null;
  }, [edit.value, edit.cursor, menuOff]);
  const menuOpen = menu !== null && menu.rows.length > 0;
  const change = (next: ed.Edit) => {
    if (next.value !== edit.value) (setMenuOff(false), setMenuIndex(0));
    setEdit(next);
  };
  const acceptMenu = (): ed.Edit => {
    const row = menu!.rows[Math.min(menuIndex, menu!.rows.length - 1)];
    if (menu!.kind === "slash") return ed.at(row.text + (allCommands.find((c) => "/" + c[0] === row.text)![1] ? " " : ""));
    return ed.replaceToken(edit, token!.start, "@" + row.text + " ");
  };

  // ---- running things ----
  const remember = (text: string) => {
    if (history.current[0] === text) return;
    history.current = [text, ...history.current].slice(0, HISTORY_MAX);
    mkdirSync(app.stateDir, { recursive: true });
    writeFileSync(historyFile, JSON.stringify(history.current));
  };

  const runTask = async (text: string, shown = text) => {
    store.user(shown);
    setBusy(true);
    const { result, info } = await app.run(text);
    store.finish(result, info);
    if (info.wallMs > BELL_AFTER_MS) process.stderr.write("\x07");
    setBusy(false);
    if (app.mode === "plan" && result.status === "done")
      setOverlay({
        type: "plan",
        choices: [
          { label: "Yes, carry it out, and don't ask before edits", value: "auto" },
          { label: "Yes, carry it out, asking before each edit", value: "ask" },
          { label: "No, keep planning", value: "keep" },
        ],
      });
  };

  const command = async (name: string, arg: string) => {
    const say = (text: string, tone: "dim" | "warn" | "error" | "plain" = "plain") => store.note(text, tone);
    switch (name) {
      case "exit":
      case "quit":
        return exit();
      case "help":
        return say(`${allCommands.map(([n, a, h]) => `/${`${n} ${a}`.padEnd(28)} ${p.dim(h)}`).join("\n")}\n\n${p.dim(KEYS)}`);
      case "context": {
        const used = app.contextUsed;
        const pct = Math.round((100 * used) / app.contextSize);
        const cells = 40;
        const filled = Math.round((cells * used) / app.contextSize);
        const calls = Object.entries(app.stats.toolCalls).map(([k, v]) => `${k} ${v}`).join(", ");
        return say(`${"█".repeat(filled)}${p.dim("░".repeat(cells - filled))}  ${used} of ${app.contextSize} tokens (${pct}%)\n${p.dim(`${app.messages.length} messages · ${app.stats.turns.length} model calls · tools: ${calls || "none yet"}\nautomatic shortening at 85% · session file ${app.session.file}`)}`);
      }
      case "compact": {
        setBusy(true);
        const problem = await app.compact();
        store.update((l) => (l.activity = null));
        setBusy(false);
        return problem ? say(problem, "warn") : undefined;
      }
      case "clear":
        app.clear();
        return say("New conversation. The previous one is under /resume.", "dim");
      case "resume":
        return openResume();
      case "rename":
        if (!arg) return say(app.name ? `This session is named "${app.name}".` : "Give a name: /rename fix the tax bug", "dim");
        app.rename(arg);
        refresh();
        return say(`Session named "${app.name}".`, "dim");
      case "export": {
        const file = resolve(app.root, arg || `heyho-session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.md`);
        writeFileSync(file, app.exportText());
        return say(`Wrote the conversation to ${file}`, "dim");
      }
      case "copy": {
        const last = app.lastReply();
        if (!last) return say("No reply to copy yet.", "dim");
        const r = spawnSync("pbcopy", { input: last });
        return say(r.status === 0 ? "Copied the last reply to the clipboard." : "Could not reach the clipboard (pbcopy is macOS only).", r.status === 0 ? "dim" : "warn");
      }
      case "status":
        return say(app.status(version).join("\n"));
      case "mcp":
        return say(app.describeServers().join("\n"));
      case "skills":
        return say(app.skills.length ? app.skills.map((s) => `${s.name}  ${p.dim(s.description)}  ${p.dim(s.file.replace(homedir(), "~"))}`).join("\n") : "No skills. A skill is a file at .heyho/skills/<name>/SKILL.md (or in ~/.heyho/skills) with a description and instructions.");
      case "agents":
        return say(app.agents.length ? app.agents.map((a) => `${a.name}  ${p.dim(a.description)}${a.tools ? p.dim(`  tools: ${a.tools.join(", ")}`) : ""}`).join("\n") : "No subagents. A subagent is a file at .heyho/agents/<name>.md (or in ~/.heyho/agents) holding its instructions.");
      case "hooks":
        return say(app.describeHooks().join("\n"));
      case "tasks": {
        const [verb, n] = arg.split(/\s+/);
        const job = app.jobs.find((j) => j.id === Number(n));
        if (verb === "stop") {
          if (!job) return say("Which one? /tasks stop <number>", "warn");
          app.stopJob(job);
          return say(`Stopped job ${job.id}.`, "dim");
        }
        if (!app.jobs.length) return say("No background commands in this session.", "dim");
        return say(app.jobs.map((j) => `${j.id}  ${app.jobRunning(j) ? p.green("running") : p.dim(j.exit === undefined || j.exit === null ? "ended" : `exit ${j.exit}`)}  ${tidyPaths(j.command.split("\n")[0], app.root).replace(/^cd \. && /, "").slice(0, 60)}  ${p.dim(j.log)}`).join("\n"));
      }
      case "rewind": {
        if (!app.checkpoints.length) return say("Nothing to go back to yet.", "dim");
        return setOverlay({ type: "rewind", choices: app.checkpoints.map((c, i) => ({ label: c.text.split("\n")[0].slice(0, width - 12), value: i })) });
      }
      case "undo": {
        const r = app.undo();
        if (!r) return say("No file changes to take back.", "dim");
        if (r.restored.length) say(`Restored: ${r.restored.join(", ")}`);
        if (r.skipped.length) say(`Left alone because they changed after heyho wrote them: ${r.skipped.join(", ")}`, "warn");
        return say("Commands heyho ran are not undone.", "dim");
      }
      case "diff": {
        const r = app.shell("git diff --stat && git diff");
        return say(r.output.trim() || "No uncommitted changes.");
      }
      case "mode":
        if (MODES.includes(arg as Mode)) app.setMode(arg as Mode);
        else if (arg) return say(`Modes: ${MODES.map((m) => `${m} (${MODE_HELP[m]})`).join("; ")}.`, "warn");
        refresh();
        return say(`mode: ${app.mode} (${MODE_HELP[app.mode]})`, "dim");
      case "allowed":
      case "permissions": {
        const [verb, ...rest] = arg.split(/\s+/);
        const rule = rest.join(" ");
        if (verb === "reset") app.approvals.forget();
        else if (verb === "allow" || verb === "ask" || verb === "deny") {
          if (!app.approvals.addRule(verb, rule)) return say(`"${rule}" is not a rule. Examples: bash(npm test *), edit(src/**), read(.env)`, "warn");
          say(`Added for this session: ${verb} ${rule}. To keep it, put it in .heyho/settings.json.`, "dim");
        } else if (verb === "remove") say(app.approvals.removeRule(rule) ? `Removed ${rule}.` : `No saved or session rule "${rule}". Rules from settings files are changed there.`, "dim");
        return say(app.approvals.describe().join("\n"));
      }
      case "init":
        return runTask(INIT_TASK, "/init");
      case "memory": {
        const [verb, which] = arg.split(/\s+/);
        if (verb === "edit") {
          const targets: Record<string, string> = { user: join(heyhoHome(), "AGENTS.md"), project: join(app.root, "AGENTS.md"), local: join(app.root, "AGENTS.local.md"), notes: app.notesFile };
          const file = targets[which];
          if (!file) return say("Which one? /memory edit user, project, local or notes", "warn");
          mkdirSync(join(file, ".."), { recursive: true });
          if (!existsSync(file)) writeFileSync(file, "");
          await suspendTerminal(() => void spawnSync(process.env.VISUAL || process.env.EDITOR || "vi", [file], { stdio: "inherit", shell: true }));
          return say(`Saved ${file}. It takes effect in the next conversation (/clear, or a new session).`, "dim");
        }
        const files = app.instructionFiles();
        const names = { user: "yours, every project", parent: "a folder above", project: "this project", local: "yours, this project", notes: "kept by heyho" };
        return say(
          (files.length ? files.map((f) => `${f.file.startsWith(app.root + "/") ? f.file.slice(app.root.length + 1) : f.file.replace(homedir(), "~")}  ${p.dim(`${names[f.scope]} · ${f.chars} characters${f.cut ? ", cut to fit" : ""}`)}`).join("\n") : "No instruction files are in effect.") +
            `\n${p.dim(`Looked for: ${join(heyhoHome(), "AGENTS.md")}, AGENTS.md or CLAUDE.md here and in folders above, AGENTS.local.md, and notes at ${app.notesFile}.\nFiles in folders below are added when a file there is first read. /memory edit <which> opens one.`)}`,
        );
      }
      case "model": {
        const problem = arg ? await app.switchModel(arg) : null;
        return say(problem ?? app.banner(), problem ? "error" : "dim");
      }
      default:
        return say(`Unknown command /${name}. /help lists them.`, "warn");
    }
  };

  const process_ = async (text: string) => {
    if (text.startsWith("/") && !text.includes("\n")) {
      const [name, ...rest] = text.slice(1).split(/\s+/);
      const own = COMMANDS.some((c) => c[0] === name) ? undefined : custom.find((c) => c.name === name);
      if (own) return runTask(expand(own, rest.join(" ")), text);
      store.note(p.dim(text));
      return command(name, rest.join(" "));
    }
    if (text.startsWith("!") && !text.includes("\n")) {
      const r = app.shell(text.slice(1));
      return store.add(p.bold("!"), `${p.bold(text.slice(1).trim())}\n${r.output.trimEnd()}${r.output ? "\n" : ""}${p.dim(`exit code ${r.code}`)}`, true);
    }
    return runTask(text);
  };

  const submit = (text: string) => {
    remember(text);
    historyAt.current = -1;
    if (busy || overlay) return store.update((l) => l.queue.push(text));
    void process_(text);
  };

  // Send what was typed while the model worked, one at a time.
  useEffect(() => {
    if (busy || overlay || pending || !live.queue.length) return;
    const next = live.queue[0];
    store.update((l) => l.queue.shift());
    void process_(next);
  }, [busy, overlay, pending, live.queue.length]);

  const pickOverlay = (o: Overlay, picked: Choice<unknown>) => {
    const i = (o.choices as Choice<unknown>[]).indexOf(picked);
    setOverlay(null);
    if (o.type === "resume") {
      app.resume(o.choices[i].value);
      refresh();
      return store.note(`Reopened "${o.choices[i].label}". Your next message continues it.`, "dim");
    }
    if (o.type === "history") return setEdit(ed.at(o.choices[i].value));
    if (o.type === "trust") {
      if (o.choices[i].value) app.trust();
      return store.note(o.choices[i].value ? "Trusted. This project's hooks and allow rules are in use, here and next time. Its MCP servers start with the next session." : "Left off. The project's ask and deny rules still apply. You will be asked again next time.", "dim");
    }
    if (o.type === "rewind") {
      const index = o.choices[i].value;
      const changed = app.changes.turnCount > app.checkpoints[index].turn;
      return setOverlay({
        type: "rewindWhat",
        index,
        choices: [
          ...(changed ? [{ label: "Restore files and conversation", value: { code: true, conversation: true } }] : []),
          { label: "Restore conversation only", value: { code: false, conversation: true } },
          ...(changed ? [{ label: "Restore files only", value: { code: true, conversation: false } }] : []),
        ],
      });
    }
    if (o.type === "rewindWhat") {
      const r = app.rewind(o.index, o.choices[i].value);
      if (r.restored.length) store.note(`Restored: ${r.restored.join(", ")}`);
      if (r.skipped.length) store.note(`Left alone because they changed after heyho wrote them: ${r.skipped.join(", ")}`, "warn");
      store.note(o.choices[i].value.conversation ? "Went back to before that message. It is in the input box to edit and send again." : "Files restored; the conversation is unchanged.", "dim");
      if (o.choices[i].value.conversation) setEdit(ed.at(r.text));
      return;
    }
    const pick = o.choices[i].value;
    if (pick === "keep") return store.note("Still in plan mode. Say what to change in the plan.", "dim");
    app.setMode(pick);
    void runTask("Carry out the plan.");
  };

  usePaste((text) => {
    const clean = text.replace(/\r\n?/g, "\n");
    if (saying) setSaying(ed.insert(saying, clean.replace(/\n/g, " ")));
    else if (!pending && !overlay) change(ed.insert(edit, clean));
  });

  useInput((input, key) => {
    // Works everywhere.
    if (key.ctrl && input === "c") {
      if (busy) {
        // The tool waiting on the answer has to hear one, or the run never ends.
        app.interrupt();
        setSaying(null);
        store.live.asking?.resolve("(the user stopped the run without answering)");
        return pending?.resolve("no");
      }
      if (!pending && !overlay && edit.value) return change(ed.EMPTY);
      if (Date.now() - lastCtrlC.current < DOUBLE_PRESS_MS * 2) return exit();
      lastCtrlC.current = Date.now();
      setExitHint(true);
      setTimeout(() => setExitHint(false), DOUBLE_PRESS_MS * 2);
      return;
    }
    if (key.tab && key.shift) {
      app.cycleMode();
      return refresh();
    }
    if (key.ctrl && input === "o") return store.expandOutput();
    if (key.ctrl && input === "t") return setShowTodos((v) => !v);

    // The model asked a question: pick an option, or type an answer.
    const asking = store.live.asking;
    if (asking) {
      if (saying) {
        if (key.escape && asking.options.length) return setSaying(null);
        if (key.return) return saying.value.trim() ? (asking.resolve(saying.value.trim()), setSaying(null)) : undefined;
        if (key.backspace || key.delete) return setSaying(ed.backspace(saying));
        if (key.leftArrow) return setSaying(ed.left(saying));
        if (key.rightArrow) return setSaying(ed.right(saying));
        if (input && !key.ctrl && !key.meta) return setSaying(ed.insert(saying, input));
        return;
      }
      const count = asking.options.length + 1;
      if (key.upArrow) return setChoice((c) => (c + count - 1) % count);
      if (key.downArrow) return setChoice((c) => (c + 1) % count);
      const n = Number(input);
      const picked = key.return ? choice : input && n >= 1 && n <= count ? n - 1 : -1;
      if (picked < 0) return;
      return picked < asking.options.length ? asking.resolve(asking.options[picked]) : setSaying(ed.EMPTY);
    }
    if (key.ctrl && input === "l") {
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      return setPrinted((n) => n + 1);
    }

    // Typing what to do instead of approving.
    if (saying && pending) {
      if (key.escape) return setSaying(null);
      if (key.return) {
        const text = saying.value.trim();
        setSaying(null);
        return pending.resolve(text ? { say: text } : "no");
      }
      if (key.backspace || key.delete) return setSaying(ed.backspace(saying));
      if (key.leftArrow) return setSaying(ed.left(saying));
      if (key.rightArrow) return setSaying(ed.right(saying));
      if (input && !key.ctrl && !key.meta) return setSaying(ed.insert(saying, input));
      return;
    }

    // A question is on the screen: an approval, or one of the pickers.
    const choices: Choice<unknown>[] | null = pending ? approvalChoices(pending.request) : shownChoices;
    if (choices) {
      const pick = (i: number) => {
        if (pending) {
          const v = approvalChoices(pending.request)[i].value;
          return v === "say" ? setSaying(ed.EMPTY) : pending.resolve(v);
        }
        if (choices[i]) pickOverlay(overlay!, choices[i]);
      };
      if (searchable && !pending) {
        if (key.backspace || key.delete) return setFilter((f) => f.slice(0, -1));
        if (input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape && !key.upArrow && !key.downArrow) return setFilter((f) => f + input);
      }
      if (key.escape) return pending ? pending.resolve("no") : setOverlay(null);
      if (key.upArrow) return setChoice((c) => (c + choices.length - 1) % choices.length);
      if (key.downArrow) return setChoice((c) => (c + 1) % choices.length);
      if (key.return) return pick(choice);
      if (key.tab && pending) return setSaying(ed.EMPTY);
      if (key.tab && overlay?.type === "resume") return setPreview((on) => !on);
      const n = Number(input);
      if (input && n >= 1 && n <= choices.length && !searchable && overlay?.type !== "rewind") return pick(n - 1);
      return;
    }

    // The input box. With vim keys on, Esc leaves insert mode first, and letters are commands in normal mode.
    if (app.vim) {
      if (key.escape && vimInsert && !menuOpen) {
        // As in vim, the cursor steps back onto the last character typed, unless it is at the start of a line.
        if (edit.cursor > 0 && edit.value[edit.cursor - 1] !== "\n") setEdit({ ...edit, cursor: edit.cursor - 1 });
        return setVimInsert(false);
      }
      if (!vimInsert && input && !key.ctrl && !key.meta && !key.return && !key.tab && !key.escape) {
        let now = edit; // several keys can arrive at once; each acts on the result of the one before
        for (const ch of input) {
          const next = normalKey({ edit: now, insert: false, pending: vimPending.current, ...vimKept.current }, ch);
          if (!next) {
            // j or k at the edge of the text: move through earlier messages.
            const h = history.current;
            if (ch === "k" && historyAt.current < h.length - 1) setEdit(ed.at(h[++historyAt.current]));
            else if (ch === "j" && historyAt.current >= 0) setEdit(ed.at(--historyAt.current < 0 ? "" : h[historyAt.current]));
            return;
          }
          vimPending.current = next.pending;
          vimKept.current = { register: next.register, undo: next.undo };
          now = next.edit;
          if (next.insert) {
            setVimInsert(true);
            now = ed.insert(now, input.slice(input.indexOf(ch) + 1)); // the rest of the burst is text
            break;
          }
        }
        return change(now);
      }
    }
    if (key.escape) {
      if (menuOpen) return setMenuOff(true);
      if (busy) return app.interrupt();
      const twice = Date.now() - lastEsc.current < DOUBLE_PRESS_MS;
      lastEsc.current = Date.now();
      if (!twice) return;
      if (edit.value) return change(ed.EMPTY);
      return void command("rewind", "");
    }
    if (key.ctrl && input === "d") return edit.value ? change(ed.del(edit)) : exit();
    if (key.ctrl && input === "r") {
      if (!history.current.length) return;
      return setOverlay({ type: "history", choices: history.current.map((h) => ({ label: h.split("\n")[0].slice(0, width - 8), value: h })) });
    }
    if (key.ctrl && input === "s") {
      // Sets the draft aside; pressed again on an empty box, brings it back.
      if (edit.value) return (stash.current = edit.value), change(ed.EMPTY);
      if (stash.current !== null) return change(ed.at(stash.current)), void (stash.current = null);
      return;
    }
    if (key.ctrl && input === "g") {
      const file = join(mkdtempSync(join(tmpdir(), "heyho-edit-")), "message.md");
      writeFileSync(file, edit.value);
      return void suspendTerminal(() => void spawnSync(process.env.VISUAL || process.env.EDITOR || "vi", [file], { stdio: "inherit", shell: true })).then(() => change(ed.at(readFileSync(file, "utf8").replace(/\n$/, ""))));
    }
    if (input === "?" && !edit.value) return void command("help", "");
    if (key.return) {
      if (key.meta || key.shift) return change(ed.insert(edit, "\n"));
      if (edit.value[edit.cursor - 1] === "\\" && edit.cursor === edit.value.length) return change(ed.insert(ed.backspace(edit), "\n"));
      const typed = menuOpen && menu!.kind === "slash" ? acceptMenu().value.trim() : edit.value.trim();
      if (menuOpen && menu!.kind === "file") return change(acceptMenu());
      if (!typed) return;
      setEdit(ed.EMPTY);
      setMenuOff(false);
      setVimInsert(true);
      return submit(typed);
    }
    if (input === "\n" || (key.ctrl && input === "j")) return change(ed.insert(edit, "\n"));
    if (key.tab) return menuOpen ? change(acceptMenu()) : undefined;
    if (key.upArrow || key.downArrow) {
      const dir = key.upArrow ? -1 : 1;
      if (menuOpen) return setMenuIndex((i) => (i + dir + menu!.rows.length) % menu!.rows.length);
      const moved = ed.vertical(edit, dir);
      if (moved) return setEdit(moved);
      const h = history.current;
      if (dir < 0 && historyAt.current < h.length - 1) {
        if (historyAt.current < 0) draft.current = edit.value;
        return setEdit(ed.at(h[++historyAt.current]));
      }
      if (dir > 0 && historyAt.current >= 0) return setEdit(ed.at(--historyAt.current < 0 ? draft.current : h[historyAt.current]));
      return;
    }
    if (key.leftArrow) return setEdit(ed.left(edit));
    if (key.rightArrow) return setEdit(ed.right(edit));
    if (key.home || (key.ctrl && input === "a")) return setEdit(ed.home(edit));
    if (key.end || (key.ctrl && input === "e")) return setEdit(ed.end(edit));
    if (key.ctrl && input === "k") return change(ed.killToEnd(edit));
    if (key.ctrl && input === "u") return change(ed.killToStart(edit));
    if (key.ctrl && input === "w") return change(ed.killWord(edit));
    if (key.backspace || key.delete) return change(ed.backspace(edit));
    if (input && !key.ctrl && !key.meta) {
      // Text and Enter can arrive together (a fast typist, a script): send what came before the Enter.
      const [text, ...more] = input.split(/\r\n?|\n/);
      const typed = ed.insert(edit, text);
      if (!more.length) return change(typed);
      setEdit(ed.EMPTY);
      if (typed.value.trim()) submit(typed.value.trim());
    }
  });

  // ---- drawing ----
  const a = live.activity;
  const used = app.contextUsed;
  const pct = Math.round((100 * used) / app.contextSize);
  const panelRows = Math.max(6, rows - 16);
  const asking = pending ? pending.request : null;
  const diff = asking?.change ? renderDiff(asking.change, p, panelRows) : null;

  return (
    <Box flexDirection="column">
      <Static key={printed} items={store.items}>
        {(item) => (
          <Box key={item.id} marginTop={item.gap ? 1 : 0} width={width}>
            <Box width={2} flexShrink={0}>
              <Text>{item.mark}</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text>{item.text}</Text>
            </Box>
          </Box>
        )}
      </Static>

      {live.partial ? (
        <Box width={width} paddingLeft={2}>
          <Text>{live.partial}</Text>
        </Box>
      ) : null}
      {a ? (
        <Box marginTop={1}>
          <Text color={ACCENT}>{FRAMES[Math.floor(Date.now() / 120) % FRAMES.length]} </Text>
          <Text dimColor wrap="truncate-end">
            {`${a.label} · ${secs(Date.now() - a.since)}${a.detail ? ` · ${a.detail}` : ""} · esc to stop`}
          </Text>
        </Box>
      ) : null}

      {asking ? (
        <Box flexDirection="column" marginTop={1}>
          <Rule width={width} />
          <Text bold>{asking.change ? changeTitle(asking.change) : asking.kind === "fetch" ? "Fetch a web page" : asking.kind === "mcp" ? "Use an MCP tool" : asking.background ? "Run a command in the background" : "Run a command"}</Text>
          <Box flexDirection="column" paddingLeft={1} marginY={1}>
            <Text>{diff ? diff.lines.join("\n") : tidyPaths(asking.summary, app.root)}</Text>
          </Box>
          {saying ? (
            <Box>
              <Text>What should it do instead? </Text>
              <InputText edit={saying} active hint="" />
            </Box>
          ) : (
            <>
              <Text>{asking.change ? (asking.change.before === null ? "Create this file?" : "Make this edit?") : asking.kind === "fetch" ? "Fetch this page?" : asking.kind === "mcp" ? "Use this tool?" : "Run this command?"}</Text>
              <List choices={approvalChoices(asking)} index={choice} />
            </>
          )}
          <Text dimColor>{saying ? "Enter to send · Esc to go back" : "Enter to choose · Esc to decline · Tab to say what to do instead"}</Text>
        </Box>
      ) : null}

      {overlay ? (
        <Box flexDirection="column" marginTop={1}>
          <Rule width={width} />
          <Text bold>
            {overlay.type === "trust" ? "This project sets hooks, allow rules or MCP servers, which run commands without asking. Use them?" : overlay.type === "resume" ? "Reopen a session" : overlay.type === "history" ? "Earlier messages" : overlay.type === "rewind" ? "Go back to before which message?" : overlay.type === "rewindWhat" ? "What should be restored?" : "Carry out this plan?"}
          </Text>
          {searchable ? <Text>{`Search: ${filter}`}<Text dimColor>{filter ? "" : "type to narrow the list"}</Text></Text> : null}
          <List choices={shownChoices!} index={Math.min(choice, Math.max(0, shownChoices!.length - 1))} numbered={overlay.type === "rewindWhat" || overlay.type === "plan" || overlay.type === "trust"} />
          {shownChoices!.length ? null : <Text dimColor>  nothing matches</Text>}
          {overlay.type === "resume" && preview && shownChoices![Math.min(choice, shownChoices!.length - 1)] ? (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>Asked in this session:</Text>
              {sessionPreview((shownChoices![Math.min(choice, shownChoices!.length - 1)].value as SessionInfo).file).map((line, n) => (
                <Text key={n} dimColor wrap="truncate-end">{`  ${line}`}</Text>
              ))}
            </Box>
          ) : null}
          <Text dimColor>{overlay.type === "resume" ? `Enter to choose · Tab ${preview ? "hides the preview" : "previews"} · Esc to cancel` : "Enter to choose · Esc to cancel"}</Text>
        </Box>
      ) : null}

      {live.asking ? (
        <Box flexDirection="column" marginTop={1}>
          <Rule width={width} />
          <Text bold>{live.asking.question}</Text>
          {saying ? (
            <Box>
              <Text>Your answer: </Text>
              <InputText edit={saying} active hint="" />
            </Box>
          ) : (
            <List choices={[...live.asking.options.map((o) => ({ label: o, value: o })), { label: "Something else (type it)", value: "" }]} index={choice} />
          )}
          <Text dimColor>{saying ? "Enter to send" : "Enter to choose"}</Text>
        </Box>
      ) : null}

      {showTodos && live.todos.length && !asking && !overlay ? (
        <Box flexDirection="column" marginTop={1}>
          {live.todos.slice(0, 10).map((t, i) => (
            <Text key={i} dimColor={t.status === "done"} color={t.status === "doing" ? ACCENT : undefined} wrap="truncate-end">
              {`  ${t.status === "done" ? "☑" : t.status === "doing" ? "◐" : "☐"} ${t.text}`}
            </Text>
          ))}
          {live.todos.length > 10 ? <Text dimColor>{`  … ${live.todos.length - 10} more`}</Text> : null}
        </Box>
      ) : null}

      {live.queue.map((q, i) => (
        <Text key={i} dimColor>{`  queued: ${q.split("\n")[0].slice(0, width - 12)}`}</Text>
      ))}

      {!asking && !overlay && !live.asking ? (
        <Box flexDirection="column" marginTop={1}>
          <Rule width={width} />
          <Box width={width}>
            <Box width={2} flexShrink={0}>
              <Text bold>›</Text>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
              <InputText edit={edit} active hint={busy ? "type to queue a message" : "describe a task · / commands · @ files"} />
            </Box>
          </Box>
          <Rule width={width} />
          {menuOpen ? (
            <Box flexDirection="column">
              {menu!.rows.map((r, i) => (
                <Text key={r.text} color={i === menuIndex ? ACCENT : undefined} wrap="truncate-end">
                  {i === menuIndex ? "❯ " : "  "}
                  {r.text.padEnd(menu!.kind === "slash" ? 12 : 0)}
                  <Text dimColor>{r.hint ? `  ${r.hint}` : ""}</Text>
                </Text>
              ))}
            </Box>
          ) : (
            <Footer width={width} mode={app.mode} hint={exitHint ? "press ctrl+c again to quit" : app.vim ? (vimInsert ? "-- INSERT --" : "-- NORMAL --") : `${MODE_SHORT[app.mode]} · shift+tab changes`} right={statusText || `${app.jobs.filter((j) => app.jobRunning(j)).length ? `${app.jobs.filter((j) => app.jobRunning(j)).length} in background · ` : ""}${app.name ? `${app.name} · ` : ""}${app.profile.model} · ${pct}% context`} />
          )}
        </Box>
      ) : null}
    </Box>
  );
}
