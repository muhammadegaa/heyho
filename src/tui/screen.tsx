// The interactive screen: the transcript scrolls above, and below it sit whatever is in
// progress, any question for the user, the input box and a footer.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Box, Static, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { INIT_TASK, type App, type ApprovalAnswer, type ApprovalRequest } from "../app.ts";
import { MODE_HELP, MODES, type Mode } from "../approve.ts";
import { listFiles } from "../input.ts";
import type { SessionInfo } from "../session.ts";
import { changeTitle, paint, renderDiff } from "../ui.ts";
import * as ed from "./edit.ts";
import { secs, type Store } from "./store.ts";

const p = paint(true);
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
  ["mode", "[ask|auto|plan|yolo]", "show or set the mode"],
  ["allowed", "[reset]", "what runs without asking; reset forgets saved rules"],
  ["init", "", "have the model write AGENTS.md for this project"],
  ["model", "[profile]", "show or switch the model profile"],
  ["exit", "", "quit"],
];

const KEYS = `Enter sends · \\ then Enter, Option+Enter or Ctrl+J starts a new line · paste keeps its lines
/ commands · @ files · ! runs a shell command yourself · Up/Down history
Shift+Tab changes mode · Esc stops the model · Esc Esc on an empty line opens rewind
Ctrl+O shows the last command's full output · Ctrl+C twice or Ctrl+D quits`;

const MODE_LABEL: Record<Mode, string> = { ask: "⏸ ask", auto: "⏵⏵ auto", plan: "⏸ plan", yolo: "⏵⏵ yolo" };
const MODE_SHORT: Record<Mode, string> = { ask: "asks before edits and commands", auto: "edits don't ask", plan: "read-only, proposes a plan", yolo: "nothing asks, commands sandboxed" };

type Choice<T> = { label: string; hint?: string; value: T };
type Overlay =
  | { type: "resume"; choices: Choice<SessionInfo>[] }
  | { type: "rewind"; choices: Choice<number>[] }
  | { type: "rewindWhat"; index: number; choices: Choice<{ code: boolean; conversation: boolean }>[] }
  | { type: "plan"; choices: Choice<"auto" | "ask" | "keep">[] };

function approvalChoices(req: ApprovalRequest): Choice<ApprovalAnswer | "say">[] {
  const always =
    req.kind !== "bash"
      ? { label: `Yes, and don't ask again for ${req.kind === "edit" ? "edits" : "new files"} this session`, value: "always" as const }
      : req.prefix
        ? { label: `Yes, and don't ask again in this project for: ${req.prefix} …`, value: "prefix" as const }
        : { label: "Yes, and don't ask again in this project for this exact command", value: "always" as const };
  return [{ label: "Yes", value: "yes" }, always, { label: "No, and say what to do instead", value: "say" }];
}

function List<T>({ choices, index, numbered = true }: { choices: Choice<T>[]; index: number; numbered?: boolean }) {
  return (
    <Box flexDirection="column">
      {choices.map((c, i) => (
        <Text key={i} color={i === index ? "cyan" : undefined}>
          {i === index ? "❯ " : "  "}
          {numbered ? `${i + 1}. ` : ""}
          {c.label}
          {c.hint ? <Text dimColor>{`  ${c.hint}`}</Text> : null}
        </Text>
      ))}
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

export function Screen({ app, store, version }: { app: App; store: Store; version: string }) {
  useSyncExternalStore(store.subscribe, store.snapshot);
  const { exit } = useApp();
  const { columns, rows } = useWindowSize();
  const width = Math.max(40, columns);

  const [edit, setEdit] = useState<ed.Edit>(ed.EMPTY);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuOff, setMenuOff] = useState(false); // closed with Esc until the text changes
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [choice, setChoice] = useState(0); // selected row of the approval or overlay list
  const [saying, setSaying] = useState<ed.Edit | null>(null); // typing what to do instead
  const [busy, setBusy] = useState(false);
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

  const { live } = store;
  const pending = live.pending;

  // Redraw the spinner while something is in progress.
  useEffect(() => {
    if (!live.activity) return;
    const timer = setInterval(refresh, 120);
    return () => clearInterval(timer);
  }, [Boolean(live.activity)]);

  // The most recent message is the likeliest place to go back to.
  useEffect(() => setChoice(overlay?.type === "rewind" ? overlay.choices.length - 1 : 0), [pending, overlay?.type]);
  useEffect(() => {
    if (pending && app.runningFor > BELL_AFTER_MS) process.stderr.write("\x07");
  }, [pending]);

  // ---- menus that follow what is typed ----
  const slashQuery = !edit.value.includes("\n") && /^\/\S*$/.test(edit.value) ? edit.value.slice(1) : null;
  const token = slashQuery === null ? ed.atToken(edit) : null;
  const menu = useMemo(() => {
    if (menuOff) return null;
    if (slashQuery !== null) {
      const names = ed.rank(COMMANDS.map((c) => c[0]), slashQuery, MENU_ROWS);
      return { kind: "slash" as const, rows: names.map((n) => ({ text: "/" + n, hint: COMMANDS.find((c) => c[0] === n)![2] })) };
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
    if (menu!.kind === "slash") return ed.at(row.text + (COMMANDS.find((c) => "/" + c[0] === row.text)![1] ? " " : ""));
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
        return say(`${COMMANDS.map(([n, a, h]) => `/${`${n} ${a}`.padEnd(28)} ${p.dim(h)}`).join("\n")}\n\n${p.dim(KEYS)}`);
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
      case "resume": {
        const list = app.sessions();
        if (!list.length) return say("No earlier sessions in this folder.", "dim");
        return setOverlay({ type: "resume", choices: list.map((s) => ({ label: s.first, hint: `${s.when.toLocaleString()} · ${s.turns} message${s.turns > 1 ? "s" : ""}`, value: s })) });
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
        if (arg === "reset") app.approvals.forget();
        return say(app.approvals.describe().join("\n"));
      case "init":
        return runTask(INIT_TASK, "/init");
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

  const pickOverlay = (o: Overlay, i: number) => {
    setOverlay(null);
    if (o.type === "resume") {
      app.resume(o.choices[i].value);
      return store.note(`Reopened "${o.choices[i].label}". Your next message continues it.`, "dim");
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
      if (busy) return app.interrupt();
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
    const choices = pending ? approvalChoices(pending.request) : overlay ? overlay.choices : null;
    if (choices) {
      const pick = (i: number) => {
        if (pending) {
          const v = approvalChoices(pending.request)[i].value;
          return v === "say" ? setSaying(ed.EMPTY) : pending.resolve(v);
        }
        pickOverlay(overlay!, i);
      };
      if (key.escape) return pending ? pending.resolve("no") : setOverlay(null);
      if (key.upArrow) return setChoice((c) => (c + choices.length - 1) % choices.length);
      if (key.downArrow) return setChoice((c) => (c + 1) % choices.length);
      if (key.return) return pick(choice);
      if (key.tab && pending) return setSaying(ed.EMPTY);
      const n = Number(input);
      if (input && n >= 1 && n <= choices.length && overlay?.type !== "resume" && overlay?.type !== "rewind") return pick(n - 1);
      return;
    }

    // The input box.
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
    if (key.return) {
      if (key.meta || key.shift) return change(ed.insert(edit, "\n"));
      if (edit.value[edit.cursor - 1] === "\\" && edit.cursor === edit.value.length) return change(ed.insert(ed.backspace(edit), "\n"));
      const typed = menuOpen && menu!.kind === "slash" ? acceptMenu().value.trim() : edit.value.trim();
      if (menuOpen && menu!.kind === "file") return change(acceptMenu());
      if (!typed) return;
      setEdit(ed.EMPTY);
      setMenuOff(false);
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
      <Static items={store.items}>
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
          <Text color="cyan">{FRAMES[Math.floor(Date.now() / 120) % FRAMES.length]} </Text>
          <Text dimColor wrap="truncate-end">
            {`${a.label} · ${secs(Date.now() - a.since)}${a.detail ? ` · ${a.detail}` : ""} · esc to stop`}
          </Text>
        </Box>
      ) : null}

      {asking ? (
        <Box flexDirection="column" marginTop={1}>
          <Rule width={width} />
          <Text bold>{asking.change ? changeTitle(asking.change) : "Run a command"}</Text>
          <Box flexDirection="column" paddingLeft={1} marginY={1}>
            <Text>{diff ? diff.lines.join("\n") : asking.summary.split(app.root + "/").join("").split(app.root).join(".")}</Text>
          </Box>
          {saying ? (
            <Box>
              <Text>What should it do instead? </Text>
              <InputText edit={saying} active hint="" />
            </Box>
          ) : (
            <>
              <Text>{asking.change ? (asking.change.before === null ? "Create this file?" : "Make this edit?") : "Run this command?"}</Text>
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
            {overlay.type === "resume" ? "Reopen a session" : overlay.type === "rewind" ? "Go back to before which message?" : overlay.type === "rewindWhat" ? "What should be restored?" : "Carry out this plan?"}
          </Text>
          <List choices={overlay.choices as Choice<unknown>[]} index={choice} numbered={overlay.type === "rewindWhat" || overlay.type === "plan"} />
          <Text dimColor>Enter to choose · Esc to cancel</Text>
        </Box>
      ) : null}

      {live.queue.map((q, i) => (
        <Text key={i} dimColor>{`  queued: ${q.split("\n")[0].slice(0, width - 12)}`}</Text>
      ))}

      {!asking && !overlay ? (
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
                <Text key={r.text} color={i === menuIndex ? "cyan" : undefined} wrap="truncate-end">
                  {i === menuIndex ? "❯ " : "  "}
                  {r.text.padEnd(menu!.kind === "slash" ? 12 : 0)}
                  <Text dimColor>{r.hint ? `  ${r.hint}` : ""}</Text>
                </Text>
              ))}
            </Box>
          ) : (
            <Box justifyContent="space-between" width={width}>
              <Text color={app.mode === "ask" ? undefined : app.mode === "plan" ? "blue" : "yellow"}>
                {`  ${MODE_LABEL[app.mode]}`}
                <Text dimColor>{exitHint ? " · press ctrl+c again to quit" : ` · ${MODE_SHORT[app.mode]} · shift+tab changes`}</Text>
              </Text>
              <Text dimColor>{`${app.profile.model} · ${pct}% context · v${version} `}</Text>
            </Box>
          )}
        </Box>
      ) : null}
    </Box>
  );
}
