# Using heyho

Everything here is checked by a test in `test/` or `e2e/`, and the parts that depend on the model were also run on Qwen3.6 ([REALRUNS.md](REALRUNS.md)).

## Starting

```sh
heyho                      # a session in the current folder
heyho "task"               # run one task and exit
heyho -p [task]            # the same, with the task (or more of it) read from stdin
heyho --continue           # carry on from the last session in this folder
heyho --resume [name]      # reopen a session by name, or choose from a list
```

`heyho --help` lists every flag. The ones used most:

| Flag | What it does |
|---|---|
| `--profile <name>` | model settings: `qwen3-coder`, `qwen3.6`, or hosted `or-sonnet` / `or-qwen3.6` |
| `--base-url <url>`, `--model <name>` | point at another OpenAI-compatible server |
| `--mode <ask\|auto\|plan\|dontask>` | the mode to start in |
| `--yolo`, `--no-net` | with a task: no prompts, commands run in the macOS sandbox; `--no-net` also blocks the network |
| `--max-steps <n>` | steps per turn: 40 with a task, 100 in a session |
| `--output-format <text\|json\|stream-json>` | with a task: the reply, one JSON result, or one JSON event per line |
| `--allowed-tools`, `--disallowed-tools` | rules for this run, comma separated: `"bash(npm test *),edit"` |
| `--tools <names>` | offer the model only these tools: `read,search` |
| `--system-prompt`, `--append-system-prompt` | replace heyho's instructions, or add to them |
| `--trust-project` | use the project's hooks, allow rules and MCP servers without being asked |
| `--plain` | a line-at-a-time session with no input box |

## Modes

| Mode | Edits | Commands |
|---|---|---|
| `ask` (default) | ask first | ask first |
| `auto` | don't ask | file commands inside the project (`mkdir`, `touch`, `mv`, `cp`, `rm`, `rmdir`, `sed`) don't ask; others do |
| `plan` | refused | read-only commands only; the model proposes a plan, then you choose whether it carries it out |
| `dontask` | refused unless a rule allows them | refused unless a rule allows them |
| `yolo` | don't ask | don't ask; they run in the sandbox |

Shift+Tab cycles ask, auto, plan. `/mode <name>` sets any of them.

These commands never ask, in any mode: `ls`, `pwd`, `wc`, `cat`, `head`, `tail`, `grep`, `rg`, `find`, `cd`, `git status`, `git diff`, `git log`, `git show`. A command chained with `&&`, `||`, `;` or `|` is judged part by part. A command that redirects to a file or substitutes another command asks, unless that exact command has been allowed. `2>&1` and `2>/dev/null` do not count as redirecting.

## Keys

| Key | What it does |
|---|---|
| Enter | send |
| `\` then Enter, Option+Enter, Ctrl+J | new line |
| `/` | command menu, narrowed as you type |
| `@` | file menu; the chosen path is added to the message |
| `!command` | run a shell command yourself; the model sees its output with your next message |
| Shift+Tab | change mode |
| Esc | stop the model; twice on an empty line opens rewind |
| Up, Down | earlier messages |
| Ctrl+R | search earlier messages |
| Ctrl+G | edit the message in `$EDITOR` |
| Ctrl+S | set the draft aside, and bring it back |
| Ctrl+O | show the last command's full output |
| Ctrl+T | hide or show the checklist |
| Ctrl+L | redraw |
| Ctrl+C twice, Ctrl+D | quit |

You can type while the model works; the message is queued and sent when the turn ends.

## Commands

| Command | What it does |
|---|---|
| `/help` | commands and keys |
| `/context` | how much of the model's context is in use |
| `/compact` | shorten the conversation to free context |
| `/clear` | start a new conversation; the old one stays under `/resume` |
| `/resume` | reopen an earlier session; Tab previews what was asked in it |
| `/rewind` | go back to an earlier message: files, conversation or both |
| `/undo` | take back the file changes of the last turn that made any |
| `/diff` | uncommitted changes |
| `/rename <name>` | name the session, for `/resume` and `--resume` |
| `/export [file]` | write the conversation to a markdown file |
| `/copy` | copy the last reply |
| `/status` | version, model, folder, session |
| `/tasks [stop <n>]` | commands running in the background |
| `/hooks`, `/mcp`, `/skills`, `/agents` | what is set up |
| `/mode [name]` | show or set the mode |
| `/permissions [allow\|ask\|deny\|remove <rule>] [reset]` | show or change rules for this session |
| `/init` | have the model write `AGENTS.md` for the project |
| `/memory [edit user\|project\|local\|notes]` | the instruction files in effect |
| `/model [profile]` | show or switch the model profile |
| `/exit` | quit |

## Settings

Three files, later ones overriding earlier ones:

1. `~/.heyho/settings.json`: yours, for every project
2. `<project>/.heyho/settings.json`: the project's, shared
3. `<project>/.heyho/settings.local.json`: yours, for this project

```json
{
  "mode": "ask",
  "profile": "qwen3.6",
  "maxSteps": 100,
  "editorMode": "vim",
  "theme": "light",
  "statusLine": { "command": "git branch --show-current" },
  "permissions": { "allow": ["bash(npm test *)"], "ask": [], "deny": ["read(.env)"] },
  "hooks": {},
  "mcpServers": {}
}
```

- `editorMode`: `vim` gives the input box normal and insert modes (`h j k l w b 0 $`, `x dd dw D C cw cc`, `i a I A o O`).
- `theme`: `default`, `light` (for a light background) or `none`. The `NO_COLOR` environment variable also turns colour off.
- `statusLine.command`: the first line it prints replaces the right side of the footer. It gets the model, folder, mode, context use and session as JSON on stdin.

### Trust

A project's hooks, allow rules, MCP servers and status line command can run things without asking. The first time heyho is started in a project that sets any of them, it asks whether you trust it. "No" leaves them off; "Yes" is remembered. A task run (`heyho "task"`) cannot ask, so it needs `--trust-project`. Your own `~/.heyho/settings.json` needs no trust.

## Permission rules

A rule is a tool name, or a tool name with a pattern:

| Rule | Covers |
|---|---|
| `bash(npm test *)` | `npm test` and anything after it |
| `bash(git commit -m *)` | that prefix |
| `edit` | every edit and new file |
| `edit(src/**)` | edits under `src/` |
| `read(.env)` | reading any file named `.env` (use it under `deny`) |
| `fetch(example.com)`, `fetch(*.example.com)` | pages on that host, or any host under it |
| `mcp(github)`, `mcp(github.create_issue)` | every tool of a server, or one tool |

`deny` wins over `ask`, which wins over `allow`, in every mode. Claude Code's spellings are read as they are: `Bash(...)`, `Edit`, `Write`, `Read`, `WebFetch(domain:...)`, `mcp__server__tool`.

Choosing "don't ask again" at an approval saves a rule for the project in `~/.heyho/projects/<id>/allowed.json`. For a shell or a wrapper (`sh`, `bash`, `sudo`, `env`, `xargs` and the like) only the exact command is offered, since a rule for all of them would allow anything.

## Instruction files

heyho reads, most general first:

1. `~/.heyho/AGENTS.md`
2. `AGENTS.md` or `CLAUDE.md` in each folder above the project
3. `AGENTS.md` or `CLAUDE.md` in the project (or in its `.heyho/`)
4. `AGENTS.local.md` or `CLAUDE.local.md` in the project
5. its own notes for the project, `~/.heyho/projects/<id>/memory/NOTES.md`

An `AGENTS.md` in a subfolder is added the first time a file in that folder is read. The model can write the notes file without asking; say "remember that…" and it will. `/memory` lists the files in effect.

## Hooks

Commands of your own that run at fixed points. Each gets the event as JSON on stdin.

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "bash", "command": "grep -q 'git push' && { echo 'no pushing' >&2; exit 2; } || exit 0" }],
    "PostToolUse": [{ "matcher": "edit|write", "command": "npx prettier --write . >/dev/null" }],
    "Stop": [{ "command": "npm test >/dev/null 2>&1 || { echo 'tests fail' >&2; exit 2; }" }]
  }
}
```

| Event | Runs | Exit 0 | Exit 2 |
|---|---|---|---|
| `SessionStart` | when a session starts | its output is given to the model | |
| `UserPromptSubmit` | when you send a message | its output is added to the message | the message is refused |
| `PreToolUse` | before a tool call | the call goes ahead | the call is not made; stderr is the reason given to the model |
| `PostToolUse` | after a tool call | | stderr is added to the tool's result |
| `Stop` | when the model finishes | | the model is sent back to work with stderr as the reason, at most three times |

Any other exit code is shown as the hook's own failure and otherwise ignored. `matcher` is a tool name or several joined with `|`; without one the hook runs for every tool. Claude Code's nested form (`"hooks": [{ "type": "command", "command": … }]`) is read too.

## MCP servers

Servers that speak MCP over stdio, in `.mcp.json` at the project root or under `mcpServers` in a settings file:

```json
{ "mcpServers": { "everything": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-everything"] } } }
```

The model reaches every server's tools through one `mcp` tool, with the tool names listed in its instructions, so a large server does not fill the context with schemas. Each call asks first, and "don't ask again" covers the whole server. `/mcp` lists servers and tools. HTTP servers are not supported.

## Skills

Instructions for a kind of task, read by the model only when a task calls for them:

```
.heyho/skills/changelog/SKILL.md
```

```markdown
---
name: changelog
description: How to write a changelog entry for this project
---
Entries go in CHANGELOG.md under today's date, one line each, past tense.
```

Skills are read from `~/.heyho/skills`, then the project's `.claude/skills` and `.heyho/skills`. `/skills` lists them.

## Subagents

A role that does part of the work in a separate conversation and reports back:

```
.heyho/agents/reviewer.md
```

```markdown
---
name: reviewer
description: Reviews a file for bugs and reports them
tools: read, search
---
You review code. Report real bugs with line numbers. Never edit files.
```

`tools` limits what the subagent may use; without it, it has the same tools as the session. Subagents run one at a time. The model is offered them only when at least one is defined. `/agents` lists them.

## Your own commands

A markdown file per command, whose text is sent as the message:

```
.heyho/commands/review.md
```

```markdown
Review $ARGUMENTS for bugs. List them with line numbers. Do not edit anything.
```

`/review src/cart.js` sends that with the file name filled in. Read from `~/.heyho/commands`, then the project's `.claude/commands` and `.heyho/commands`.

## Sessions and context

Every session is a file under `~/.heyho/projects/<id>/sessions/`. `/resume`, `--continue` and `--resume` reopen one with its conversation, its rewind points and its mode.

When the conversation passes 85% of the model's context, heyho shortens it on its own: the model writes notes, your requests are carried over word for word, and the work goes on. This can happen up to three times in one turn. Files read before a shortening are read again when needed.

## What to expect from a local model

Measured on Qwen3.6-35B-A3B (Q4, 64k context) on an M1 Max:

- A small bug fix, a contained feature or a refactor across a few files in a 5,000-line repo takes 1 to 15 minutes and usually comes out right.
- "Find the bugs in this file" can take about 7 minutes before any answer: the model thinks for a long time first. The elapsed time and token count are shown while it does, and Esc stops it.
- With the display off, macOS slows the model to about a quarter of its speed.
