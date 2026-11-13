# heyho against Claude Code: what was run, what differs

2026-11-12. heyho `ui` branch at 3a95c99 with Qwen3.6-35B-A3B on llama-server, against Claude Code 2.1.323 with Haiku 5.5.

Two sources, kept apart in every table below:

- **Ran.** Both tools were started in tmux (120×45) in identical copies of a small JavaScript repo (two source files, one test file, git initialised). The same keys and the same requests were sent to both, and the screen was captured after each step. Rows marked *ran* describe what was on the screen. The captures are kept outside the repo.
- **Docs.** Claude Code's documented behaviour, read from the official docs pages on the same day. Rows marked *docs* were not executed.

Status words: **same** (no difference a user would notice), **partial** (heyho does part of it), **missing**, **defect** (heyho does it wrongly).

Not covered: Claude Code's IDE, desktop, web and cloud features, and anything that depends on a hosted service.

## Ledger: what has been closed since, and the test that shows it

The tables from section 1 on describe the first run, on 2026-11-12, before any of this. Every row here is covered by an automated test: `e2e/screen.test.ts` drives the real screen in a tmux pane against a scripted server and reads the rendered rows (66 cases); `test/` holds the unit tests (71). A row is listed only when its test passes. The scripted server stands in for the model, so these show what heyho does with a given reply, not what a model chooses to reply.

| Area | Claude Code behaviour matched | Test (name starts with) |
|---|---|---|
| Layout | Fixed input box, transcript above, footer with mode, model, context | start: header, input box… |
| Resize | Clean redraw at any width, in any state | resize: narrower then wider…; resize with a transcript…; resizing while an approval is open…; resizing while a reply streams… |
| Small windows | Usable at 44×9; footer on one line at every width | a very small window…; the footer is one line at every width… |
| Replies | Word-wrapped; tables, code, quotes, links drawn | a reply with a table…; a table is drawn with aligned columns… |
| Approvals | Numbered panel, line-numbered diff, one key answers, arrows and Enter, Esc declines | edit approval: numbered diff…; edit approval: arrow keys… |
| Say what to do instead | Tab at an approval takes a typed correction | edit approval: Tab takes a typed correction… |
| Don't ask again | For edits this session; for a command prefix, saved per project | 'don't ask again for edits'…; a prefix rule… |
| Command output | Collapsed when it passes, Ctrl+O expands, failures shown | command approval, collapsed output…; a failing command… |
| Modes | Shift+Tab cycle; accept-edits including file commands; plan with an approval menu; refuse-what-isn't-allowed | Shift+Tab cycles…; auto mode…; auto mode runs file commands…; plan mode…; dontask mode… |
| Rules | allow, ask and deny rules; deny wins in every mode; deny on read hides the file from search | rules: deny beats ask beats allow… (unit); a deny rule refuses an edit…; a deny rule stops a file being read…; an ask rule asks even in auto mode |
| Chained commands | Judged part by part; one saved rule per part | a compound command is judged part by part… (unit); a chained command offers one rule per part… |
| Settings files | User and project files; mode, profile, step limit and rules; a broken file is reported | settings files merge… (unit); the mode can come from settings…; an allow rule from the project's settings…; a settings file that is not valid JSON… |
| `/permissions` | Lists rules with their source; adds and removes | /permissions adds a deny rule… |
| Menus | `/` and `@` filter as you type | slash menu filters…; @ menu lists files… |
| Multi-line input | Backslash-Enter, Ctrl+J, paste kept whole | a message can span lines… |
| History | Up and Down; Ctrl+R search; kept per project | Up recalls the previous message…; Ctrl+R searches… |
| Editor, stash, help | Ctrl+G opens `$EDITOR`; Ctrl+S sets a draft aside; `?` shows help | Ctrl+G opens…; Ctrl+S sets a draft aside…; ? on an empty box… |
| `!` shell | Runs it, shows it, tells the model | ! runs a shell command… |
| Queue | Messages typed during a run are shown and sent after | a message typed during a run is queued… |
| Interrupt | Esc keeps what was written; Ctrl+C during an approval ends the run cleanly | Esc stops a reply in progress…; Ctrl+C during an approval… |
| Rewind | Any earlier message; files, conversation or both; survives a restart | rewind restores the file and the conversation…; rewind still restores a file after heyho is closed… |
| Sessions | Names; `--continue`; `--resume [name]`; searchable picker; mode restored | a session can be named…; --resume with no name…; the mode a session was in… |
| `/clear`, `/resume`, `/compact` listing | Session listed under its first message | /clear then /resume reopens…; a session reloads its messages… (unit) |
| Commands | `/help`, `/context`, `/status`, `/export`, `/copy`, `/diff`, `/undo`, `/rename`, `/memory` | /help lists…; /status shows…; /export writes…; /copy puts…; /undo takes back…; /memory lists… |
| Instruction files | Yours, folders above, the project's, a private one; `@file` imports; subfolder files on first read | instruction files load most general first… (unit); a line that is only @file… (unit); a subfolder's AGENTS.md is given… |
| Notes the agent keeps | Written without asking, loaded next session | the agent can write its notes file… |
| Leaving | Ctrl+C clears, twice quits | Ctrl+C clears typed text… |
| No server | A message with the command to start one | no server: a plain message… |

### Found by the tests and fixed

- Resizing left stale lines and lost the header (first hands-on try; the screen had been checked by hand at one size only).
- Ctrl+C during an approval left the run waiting forever.
- The footer wrapped onto two lines at some widths.
- A wildcard rule such as `npm test *` also covered whatever was chained or redirected after it (`npm test && rm -rf .`). Caught by a unit test before it shipped.
- Tables, quotes and links were printed as raw markdown.

### Still open

Not started, in the order planned:

1. Headless: read the task from stdin, a stream of JSON events, `--resume` in headless, tool allow and deny flags, system prompt flags.
2. Custom slash commands from markdown files.
3. Tools, each to be kept only if an eval run shows no loss: background commands, a task list, a question tool, web fetch.
4. Hooks on lifecycle events.
5. MCP servers.
6. Skills and subagents.
7. In the screen: syntax highlighting, vim keys, a configurable status line, themes, image paste.

Different by design, not planned: a second model that reviews each action (Claude Code's `auto` mode). heyho's no-prompt mode contains commands with the macOS sandbox instead. Out of scope: IDE, desktop, web and cloud features.

Limits of this evidence: the tests run in tmux only, so other terminal programs are not covered; and nothing here measures how well a local model uses these features.

## 1. What was run, step by step

| # | Step sent to both | Claude Code | heyho | Status |
|---|---|---|---|---|
| 1 | Start in a new folder | Asks whether you trust the folder before anything else. Then a header with version, model and folder, an input box between two rules, and a footer with the mode | One line with model, server, context size, mode and folder, then a `›` prompt. No trust question | partial |
| 2 | Ask what a function does | While working: one line naming the current action, elapsed time and tokens received. Tool calls collapse to "Searched for 1 pattern, read 1 file". Answer word-wrapped with a hanging indent, file reference as `src/cart.js:6`. Then "Baked for 10s" | While working: a status line with stage and time. Each tool call is its own line. Answer printed a line at a time; long lines are cut mid-word by the terminal ("on t\nhat total") | partial, defect (wrapping) |
| 3 | Ask for a one-line edit | A panel: file name, the diff with line numbers and three lines of context each side, then a numbered menu: Yes / Yes and switch to accept edits / No. One key answers. Esc cancels, Tab adds a comment | The diff with one context line and a `@@ line 7` header, no line numbers. Answer by typing `y`, `n` or `a` and Enter | partial |
| 4 | Decline with a correction | Tab turns the first option into "Yes, and tell Claude what to do next"; "No" plus text is also possible | Any typed text declines and is given to the model, which retried with the correction | same in effect |
| 5 | After the edit | The applied diff stays in the transcript with "Added 1 line, removed 1 line". A greyed suggestion for the next prompt appears in the input ("commit this") | "✓ edit src/cart.js", a summary line "changed 1 file: src/cart.js +1", and a status line with steps, time, context and speed | partial (no prompt suggestion) |
| 6 | Ask to run `npm test` | Panel with the model's one-line description of the command, the command, and a menu: Yes / Yes and don't ask again for `npm test *` / Yes and switch to auto mode / No | The command and: yes / no / always for this exact command / `p` always for "npm test …" | same in effect |
| 7 | Result of the command | Collapsed to "Ran 1 shell command"; Ctrl+O expands it | Exit code, duration and the last four lines. For `node --test` those are the least useful lines (`ℹ todo 0`, `ℹ duration_ms …`); the pass counts are cut off above | defect (which lines are shown) |
| 8 | Press Shift+Tab four times | manual → accept edits → plan → auto → manual, shown in the footer | ask → auto → plan → ask, shown before the prompt | same for the first three |
| 9 | A feature request in plan mode | Explores, then shows the plan in a scrollable panel, saves it to a file, and asks: Yes and use auto mode / Yes, manually approve edits / Tell Claude what to change. Ctrl+G opens the plan in an editor | Explores, then prints the plan as ordinary text. Carrying it out takes Shift+Tab and a message such as "go ahead" | partial |
| 10 | Approve the plan | The session is given a name from the task, shown on the input box border | No session names | missing |
| 11 | Type a message while it works | The input box stays usable; the message is queued and sent when the turn ends | The message is queued and runs as the next turn, but the typed characters are printed into the status line ("waiting for the model · 0.0 salso update the README") | defect |
| 12 | Press Esc during a long answer | Stops; what was written stays | Stops with "[interrupted]", a hint, and the status line | same |
| 13 | Type `/` | A filterable menu of commands with descriptions, updated as you type | Nothing until Tab; Tab twice lists the eleven command names | partial |
| 14 | Type `@src/` | A live list of matching files as you type | Tab twice lists matching files. Tab pressed twice quickly inserts a tab character instead (Node treats fast key bursts as a paste) | partial, defect |
| 15 | `!git status --short` | Runs it, shows the output, and the model replies about it | Runs it, shows the output; the model sees it with the next message | same in effect |
| 16 | `/context` | A grid and a breakdown by category: system prompt, tools, memory files, skills, messages, free space, auto-compact buffer | One line: tokens used, model calls, tool-call counts, session file | partial |
| 17 | Undo | `/rewind` lists every earlier message; restores code, conversation, or both to that point; can summarise from a point | `/undo` restores the files of the last turn that changed any; repeating it steps back one turn. The conversation is not rewound | partial |
| 18 | `/compact` | "Compacting conversation…" with time and tokens | Works, with the same status line as a normal turn; typed-ahead keys were printed into it | same, plus defect 11 |
| 19 | `/clear` then `/resume` | A searchable picker: session name, age, branch, size; Space previews, Ctrl+R renames | A numbered list. After a compaction the entry showed the compaction notice as the session's first message and "1 message" | partial, defect |
| 20 | `/help` | Tabs (general, commands, custom commands) and a shortcut table | A list of the eleven commands and four input hints | partial |
| 21 | Restart with `--continue` | Reopens the last session | Reopens the last session, and says which one. A headless one-off run counts as the last session | same, minor |
| 22 | Ask for a new file | Panel "Create file" with numbered lines and the same menu | "write src/tax.js (new file, 1 lines)" then the lines in green; an empty `+` line for the trailing newline | partial, defect (wording, empty line) |
| 23 | A command that exits 3 | Collapsed like any command; the model reports the exit code | "! bash … exit code 3" in yellow with the output below | same |
| 24 | Headless with JSON output | Not compared: the credentials in my test shell made Claude Code return an empty result | `--json` printed status, reply, steps, time, changes and session file | not compared |

## 2. Modes and permissions

| Item | Claude Code | heyho | Source | Status |
|---|---|---|---|---|
| Ask for everything | `default`, labelled "manual" | `ask` | ran | same |
| Edits without asking | `acceptEdits`; also allows `mkdir`, `touch`, `rm`, `rmdir`, `mv`, `cp`, `sed` in the working directory | `auto`; edits and new files only, every command still asks | ran, docs | partial |
| Read-only planning | `plan`, ends in an approval menu that switches mode | `plan`, ends in plain text | ran | partial |
| No prompts, with a safety check | `auto`: a second model reviews each action before it runs | none | ran, docs | missing |
| No prompts, no checks | `bypassPermissions`, opt-in, refused as root, meant for containers | `yolo`: no prompts, commands run inside the macOS sandbox with writes limited to the workspace | docs | different design |
| Deny anything that would ask | `dontAsk` | none (headless `ask` mode does this by accident: no terminal means declined) | docs | partial |
| Switch with a key | Shift+Tab | Shift+Tab | ran | same |
| Mode from a flag | `--permission-mode` | `--mode`, `--yolo` | docs | same |
| Default mode from a settings file | `permissions.defaultMode` | none | docs | missing |
| "Don't ask again" for a command | Saved to `.claude/settings.local.json` in the repo; one rule per subcommand of a compound command | Saved to `~/.heyho/projects/<hash>/allowed.json`; a compound command can only be allowed exactly | ran, docs | partial |
| "Don't ask again" for edits | Until the session ends | Until the session ends | docs | same |
| Rule syntax | `Tool(specifier)` with wildcards, for Bash, Read, Edit, WebFetch, MCP and subagents | Command prefixes and exact commands only | docs | partial |
| Deny and ask rules | Yes; deny wins over ask wins over allow | none | docs | missing |
| Read-only commands that never ask | A built-in set | `ls`, `pwd`, `wc`, `cat`, `head`, `tail`, `grep`, `rg`, `git status/diff/log/show`, and only with arguments inside the workspace | ran | same in effect |
| Settings levels | managed, command line, project local, project shared, user | one file per project | docs | missing |
| Extra working directories | `--add-dir`, `/add-dir` | none; paths outside the workspace are refused | docs | missing |
| Folder trust question at first start | Yes | none | ran | missing |
| OS sandbox for commands | `/sandbox` | Only in `yolo` | docs | partial |

## 3. Keys and input

| Item | Claude Code | heyho | Source | Status |
|---|---|---|---|---|
| Interrupt | Esc; Ctrl+C | Esc; Ctrl+C | ran | same |
| Exit | Ctrl+C twice, Ctrl+D | Ctrl+C at an empty prompt, Ctrl+D, `/exit` | docs | same |
| New line in a message | `\` Enter, Shift+Enter, Option+Enter, Ctrl+J, paste | `\` Enter, paste | docs | partial |
| Edit the prompt in `$EDITOR` | Ctrl+G | none | docs | missing |
| History | Up/Down, kept per folder, Ctrl+R to search | Up/Down, one history for all folders, no search | docs | partial |
| Rewind menu | Esc Esc | none | docs | missing |
| Expand tool output | Ctrl+O | none; output is never collapsed, and never fully shown | docs | missing |
| Background a running command | Ctrl+B | none | docs | missing |
| Task list toggle | Ctrl+T | none | docs | missing |
| Stash a draft | Ctrl+S | none | docs | missing |
| Paste an image | Ctrl+V | none (the local models used are text-only) | docs | missing |
| Switch model | Option+P, `/model` picker | `/model <profile>` | docs | partial |
| Line editing | Emacs keys, kill ring, undo; optional vim mode | Emacs keys from readline; no vim mode | docs | partial |
| `/` commands | Live menu | Tab completion | ran | partial |
| `@` files | Live picker | Tab completion | ran | partial |
| `!` shell | Yes, model responds at once | Yes, model sees it next turn | ran | same in effect |
| Queue messages while working | Shown greyed in the transcript until sent; Ctrl+Enter sends now | Queued, but echoed into the status line | ran | defect |
| Side question without adding to the conversation | `/btw` | none | docs | missing |
| Suggested next prompt | Yes | none | ran | missing |
| Custom key bindings | `~/.claude/keybindings.json` | none | docs | missing |

## 4. Slash commands

Claude Code documents about 120. The ones that concern a local terminal session, against heyho's eleven:

| Purpose | Claude Code | heyho | Status |
|---|---|---|---|
| Help | `/help` | `/help` | same |
| Context use | `/context`, `/usage`, `/cost`, `/stats` | `/context` | partial |
| Shorten | `/compact [instructions]`, `/autocompact` | `/compact` | partial |
| New conversation | `/clear [name]` | `/clear` | same |
| Earlier sessions | `/resume`, `/rename`, `/branch`, `/fork` | `/resume [n]` | partial |
| Undo | `/rewind` | `/undo` | partial |
| Modes and rules | `/permissions`, `/plan`, `/sandbox` | `/mode`, `/allowed` | partial |
| Model | `/model`, `/effort`, `/fast` | `/model` | partial |
| Project notes | `/init`, `/memory` | `/init` | partial |
| Working-tree diff | `/diff` | none (`!git diff`) | missing |
| Export or copy the conversation | `/export`, `/copy` | none | missing |
| Settings | `/config`, `/theme`, `/statusline`, `/keybindings`, `/output-style`, `/terminal-setup` | none | missing |
| Health check | `/doctor`, `/status` | none | missing |
| Background tasks | `/tasks`, `/background`, `/stop` | none | missing |
| Review | `/review`, `/security-review`, `/code-review` | none | missing |
| Extensions | `/mcp`, `/hooks`, `/skills`, `/agents`, `/plugin` | none | missing |
| Add a directory | `/add-dir`, `/cd` | none | missing |
| Custom commands | Markdown files in `.claude/commands` and skills | none | missing |

## 5. Sessions

| Item | Claude Code | heyho | Source | Status |
|---|---|---|---|---|
| Continue the last session | `--continue` | `--continue` | ran | same |
| Open a chosen session from the command line | `--resume <name or id>` | none | docs | missing |
| Session picker | Searchable, with preview and rename | Numbered list | ran | partial |
| Session names | Automatic and `/rename` | none | ran | missing |
| Fork a session | `/branch`, `--fork-session` | none | docs | missing |
| What a resumed session restores | Conversation, model, mode | Conversation only | docs | partial |
| Checkpoints | One per prompt, last 100 keep file snapshots, kept about 30 days on disk | Copies in memory, lost at exit | docs | partial |
| Restore | Code, conversation or both, to any earlier prompt | Files of the last changing turn | ran | partial |
| Summarise from or up to a point | In the rewind menu | none | docs | missing |
| Automatic shortening | Near the window limit; five recently touched files are re-read afterwards | At 85% of the window, once per turn; nothing is re-read | docs | partial |
| Transcripts | JSONL per session | JSONL per session | docs | same |

## 6. Project instructions and memory

| Item | Claude Code | heyho | Source | Status |
|---|---|---|---|---|
| Project file | `CLAUDE.md` or `.claude/CLAUDE.md`, and `AGENTS.md` | `AGENTS.md`, else `CLAUDE.md`, at the root, cut at 4,000 characters | docs | partial |
| User-wide file | `~/.claude/CLAUDE.md` | none | docs | missing |
| Personal project file | `CLAUDE.local.md` | none | docs | missing |
| Parent and subfolder files | Loaded from every parent at start, from subfolders on first use | none | docs | missing |
| Imports | `@path` inside the file, four levels deep | none | docs | missing |
| Path-scoped rules | `.claude/rules/*.md` | none | docs | missing |
| Memory the agent writes itself | `MEMORY.md` plus topic files per project | none | docs | missing |
| Generate the file | `/init` | `/init` | docs | same |

heyho's 4,000-character cap is deliberate: the whole fixed prompt has to stay near 1.5k tokens on a 64k local window. Closing these rows has a cost that Claude Code does not pay.

## 7. Tools the model can call

| Tool | Claude Code | heyho | Status |
|---|---|---|---|
| Read, Edit, Write | Yes | `read`, `edit`, `write` | same |
| Shell | `Bash`, two-minute default, ten-minute ceiling | `bash`, same limits | same |
| Background commands and reading their output | `run_in_background`, `Monitor`, `TaskStop` | none; a command that does not exit holds the turn until its timeout | missing |
| File and content search | `find` and `grep` through Bash on macOS; `Glob` and `Grep` elsewhere | one `search` tool | same in effect |
| Task list | `TaskCreate` and related, shown in the status area | none | missing |
| Ask the user a multiple-choice question | `AskUserQuestion` | none; the model asks in text and stops | partial |
| Enter and leave plan mode itself | `EnterPlanMode`, `ExitPlanMode` | none; only the user switches | missing |
| Web | `WebFetch`, `WebSearch` | none | missing |
| Subagents | `Agent`, `Workflow`, teams | none | missing |
| Language server | `LSP` | none | missing |
| Notebooks | `NotebookEdit` | none | missing |
| Git worktrees | `EnterWorktree`, `ExitWorktree` | none | missing |
| MCP tools and resources | Yes | none | missing |
| Skills | `Skill` | none | missing |
| Scheduling and notifications | `Cron*`, `ScheduleWakeup`, `PushNotification` | a terminal bell after long runs | partial |

Every tool heyho adds costs prompt tokens on each request and is one more schema a 35B model can misuse, so each needs an eval run before it stays.

## 8. What is on the screen

| Item | Claude Code | heyho | Source | Status |
|---|---|---|---|---|
| Layout | Transcript above, a fixed input box and footer below, redrawn in place; optional full-screen mode with mouse | Plain scrolling output; the prompt is just the next line | ran | missing |
| Activity line | Action name, time, tokens, "thinking" | Stage, time, token estimate | ran | same |
| Model text | Streams as it arrives, word-wrapped and indented | A line at a time, not wrapped | ran | defect |
| Markdown | Headings, lists, tables, highlighted code | Headings, lists, bold, inline code, code blocks without highlighting; no tables | ran, docs | partial |
| Diffs | Line numbers, context, word-level colour | Colour and context; a line unchanged in the middle of an edit shows as removed and added again | ran | defect |
| Tool calls | Collapsed summaries, expandable | One line each, plus diff or output tail | ran | partial |
| Thinking | Summary shown on request | Time only ("thought for 2.2 s") | ran | partial |
| End of a turn | "Baked for 10s" | Files changed with line counts; steps, time, context use and speed | ran | heyho shows more |
| Speed and cache figures | Not shown | tok/s after each turn | ran | heyho only |
| Cost | Estimated usage in the footer | Not applicable (local) | ran | n/a |
| Status line contents | Configurable by a script | Fixed | docs | missing |
| Themes | `/theme` | none | docs | missing |
| Notifications | Desktop notification | Terminal bell | docs | partial |

## 9. Headless use

| Item | Claude Code | heyho | Source | Status |
|---|---|---|---|---|
| One task, then exit | `-p "task"` | `heyho "task"` | docs | same |
| Read the task from stdin | Yes | none | docs | missing |
| JSON result | `--output-format json` | `--json` | ran (heyho) | same |
| Stream of JSON events | `stream-json` | none (the session JSONL file holds the same data) | docs | partial |
| JSON matching a schema | `--json-schema` | none | docs | missing |
| Continue or resume in headless | `--continue`, `--resume` | `--continue` | docs | partial |
| Limits | `--max-turns`, `--max-budget-usd` | `--max-steps` | docs | same in effect |
| Allow and deny tools from flags | `--allowedTools`, `--disallowedTools`, `--tools` | none | docs | missing |
| System prompt overrides | `--system-prompt`, `--append-system-prompt` | none | docs | missing |

## 10. Extension and configuration

Missing in heyho, all from the docs: MCP servers, hooks on lifecycle events, skills, plugins, custom subagents, custom slash commands, output styles, a settings file at any level, environment-variable switches beyond `HEYHO_PROFILE`, `HEYHO_CTX` and `HEYHO_API_KEY`.

## 11. Defects found in heyho during the run

1. Model text is not word-wrapped; the terminal cuts long lines mid-word.
2. A line that is unchanged in the middle of an edit is shown as removed and added.
3. After a command, the last four output lines are shown; for test runners those are the least useful ones.
4. Keys typed while the agent works are printed into the status line.
5. After `/compact`, `/resume` lists the session under the compaction notice with a count of 1.
6. "1 lines", and an empty `+` line for a file's trailing newline, in the new-file prompt.
7. Two fast Tab presses insert a tab character instead of completing.
8. `--continue` treats a headless one-off run as the last session.
9. The start line wraps badly when the folder path is long.

Found in the earlier scripted run and already fixed: completion outside a git repo, approval answers in the input history, output cut to a few characters in a terminal that reports no width.

## 12. Where heyho does something Claude Code does not

- The status line after each turn gives steps, time, context used and decode speed, and the files changed with line counts.
- `yolo` runs every command in the macOS sandbox with writes limited to the workspace; Claude Code's equivalent mode has no containment of its own.
- Typing a correction at an approval needs no extra key.
- It works with any OpenAI-compatible server and reads the context size from llama-server and Ollama.

## 13. Order of work

Grouped by what a user hits first. Each group ends with the tmux run repeated.

**A. Defects (section 11).** All nine.

**B. The screen.** A fixed input box with the transcript scrolling above it, which also fixes queued typing; word-by-word streaming with wrapping; numbered single-key approval menus; line numbers and a real line diff; collapsed tool output with a key to expand; a live `/` and `@` menu. This is the largest visible gap and needs a terminal UI layer in place of readline.

**C. Sessions.** Checkpoints on disk; rewind to any earlier prompt, for code, conversation or both; session names; a picker; `--resume <name>`.

**D. Modes and rules.** Plan approval menu that switches mode; `acceptEdits` covering the file commands; deny and ask rules; a settings file for the default mode and rules; rules per subcommand for compound commands.

**E. Tools, each behind an eval run.** Background commands; a task list; a question tool; web fetch.

**F. Instructions and configuration.** User-wide and parent-folder instruction files; a config file; custom commands.

**G. Later.** MCP, hooks, skills, subagents, plugins, LSP, notebooks, images.
