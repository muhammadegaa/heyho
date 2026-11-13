# Runs on the real model

Every scenario below is run by hand through tmux against Qwen3.6-35B-A3B on llama-server, and the screen is read after each step. The scripted tests in `e2e/` show what heyho does with a given reply; these runs show what happens when the model writes the replies.

Rules for the result column:

- **pass**: heyho did what the "expect" column says.
- **defect**: heyho did something wrong, or the model made a mistake heyho could have prevented or recovered from. Fixed with a test first, then rerun; the fixing commit is named.
- **model**: the model gave a plain wrong or weak answer that no harness change would fix. Recorded, not fixed.
- **not run**: still to do.

Two repos are used. **cart** is the small JavaScript example (two source files, one test file). **big** is a copy of heyho's own public source (about 4,900 lines of TypeScript with a test suite), so the multi-step tasks run on something of real size.

Earlier one-off runs (2026-11-13, before this ledger) are in [PARITY.md](PARITY.md) under "Second run on the real model". The nine defects they found are fixed in 06bac8e, 81718ee, 53f8e03 and c533795.

## Pass 1

| # | Area | Repo | Sent | Expect | Result |
|---|---|---|---|---|---|
| 1 | Read-only question | cart | `what does the total function do?` | Reads the file, answers correctly, edits nothing | pass. Read the file, answered correctly with an example from the test |
| 2 | Edit, ask mode | cart | `add a HALF code to discount that returns 50%` | Approval panel with the diff; Yes applies it | pass |
| 3 | Decline with a correction | cart | same, then Tab and `name it HALFOFF` | Retries with the new name | pass. Retried as HALFOFF |
| 4 | Edit, then verify | cart | `add a test for HALFOFF and run the tests` | Edits the test file, runs `npm test`, reports the count | pass. Added the test, ran `npm test` without asking, reported 3 passing |
| 5 | Saved command rule | cart | `run npm test`, choose "don't ask again", ask again | Second run does not ask; rule is in `/permissions` | pass. Rule `bash(npm test *)` saved and listed; the model wrote `cd . && npm test`, which the rule still covered |
| 6 | Auto mode | cart | Shift+Tab, `rename subtotal to sum everywhere` | Edits without asking; tests still pass; a command outside the built-in list still asks | pass. Three edits without asking, tests pass; `node --version` still asked |
| 7 | Plan mode | cart | plan mode, `add a tax(total, rate) function and use it in total` | No file changes; a plan; then the three-way question | pass. Read two files, wrote a three-step plan, changed nothing |
| 8 | Plan, keep planning | cart | at that question choose 3, `also cover rounding` | Plan is revised, still no changes | pass. Plan revised with rounding, still no changes |
| 9 | Plan, carry out | cart | choose 1 | Changes are made in auto mode and tests run | pass. Carried out in auto mode; 5 tests pass (checked outside heyho) |
| 10 | dontask mode | cart | `/mode dontask`, `delete the README` | Refused without a prompt; the model says so and stops | pass. Refused without a prompt; README still there |
| 11 | Deny rule | cart | `/permissions deny bash(rm *)`, `remove src/format.js with rm` | Blocked by the rule; the model does not get round it with another command | pass. `rm src/format.js` blocked by the rule; the model stopped and said so; file still there |
| 12 | Allow rule from settings | cart | `.heyho/settings.json` allows `bash(node *)`; trust; `run node -e "console.log(1)"` | Runs without asking | pass. Trust question first; after Yes, `node -e` ran without asking |
| 13 | Chained command | cart | `run npm test && git status` | Judged per part; asks only for what is not allowed | pass. `npm test && git status` did not ask (one part saved, one built in); `npm test && node -e …` asked and offered a rule for `node` only |
| 14 | Yolo, headless | cart | `heyho --yolo --no-net "add an empty-cart test and run the tests"` | No prompts; sandboxed; report of changes | pass. No prompts; two tests added; 4 pass (checked outside heyho) |
| 15 | Sandbox holds | cart | `heyho --yolo "write the word hi to ~/heyho-sandbox-check.txt"` | The write outside the folder fails and the model reports it | pass. The write to the home folder failed in the sandbox and nothing was created there; the model said so |
| 16 | Search tool | big | `where is the approval for a bash command decided?` | Uses search, names `src/approve.ts` and the function | pass. Named `src/approve.ts` and walked through `decide` with correct line numbers |
| 17 | Large file read | big | `summarise what src/tui/screen.tsx does` | Reads in pages, does not loop on the same range | pass. Read the 800-line file in four pages, no repeats, accurate summary |
| 18 | Failed edit recovery | big | `in src/ui.ts rename the function secs to seconds everywhere` | Any failed edit is retried with a corrected match; tests pass after | defect, then pass. The rename was right in three files (type check clean). A read-only `grep -rn '\\bsecs\\b' src/` asked for approval; fixed in df8e104 and rerun: no prompt |
| 19 | Write a new file | big | `add test/secs.test.ts with two tests for seconds formatting and run it` | New file panel; test runs and passes | defect, then pass. File written and its two tests pass (run outside heyho). `ls test/ 2>/dev/null \|\| echo …` asked for approval; the `2>/dev/null` part is fixed in 41c27b6 |
| 20 | Checklist | big | `add a --quiet flag to the headless mode that prints only the reply; keep a checklist` | Checklist shown and ticked as steps finish | defect, then pass. First run stopped at 40 steps with the work nearly done, printed a raw tool call as its summary, and never ticked the checklist. Fixed in 41c27b6. Rerun: 54 steps, checklist ticked item by item, `--quiet` works (checked outside heyho: reply on stdout, 0 bytes on stderr) |
| 21 | Question tool | cart | `add a new discount code; offer me three names to choose from` | A menu of choices; the pick is used | pass, model. The model listed three names in plain text and asked; it did not use the question tool. Answering `2` added that code. (In scenario 25 it used the tool unprompted, with a menu.) |
| 22 | Background command | cart | `start "python3 -m http.server 8123" in the background and check it answers` | Job is tracked in the footer and `/tasks`; `/tasks stop 1` ends it | defect, then pass. Server started as a tracked job, `curl` got 200, footer showed "1 in background", `/tasks stop 1` ended it. `/tasks` listed the `cd` in front of the command and not the program; fixed in 69f55f6 |
| 23 | Web fetch | cart | `fetch https://example.com and give me the title` | Asks by host; answer has the title | defect, then pass. The fetched text had no title, so the model fell back to `curl`. Fixed in 69f55f6; rerun answered from the fetch alone |
| 24 | Fetch rule | cart | choose "don't ask again" for the host, fetch again | No second prompt | pass. After "don't ask again" for the host, the second fetch did not ask |
| 25 | Hook blocks a tool | cart | PreToolUse hook on `bash` that exits 2 for `git push`; `push this branch` | Blocked with the hook's message; the model stops | defect, then pass. The push was blocked with the hook's message. The model called it a server-side hook; the message now says the user's own hook stopped it before it ran (69f55f6), and in the rerun the model called it "a pre-push hook in place", which is closer but still not "your project's own hook" |
| 26 | Hook after edit | cart | PostToolUse hook on `edit` that appends to a log | Log has a line per edit | pass. One line in the log per edit |
| 27 | Stop hook | cart | Stop hook that exits 2 unless `npm test` passes; ask for a change that breaks a test | The model is sent back to fix it, at most three times | defect, then pass. The hook sent the model back and it worked until `npm test` passed (3 pass, checked outside heyho). Nothing on screen said a hook had done that; fixed in 85b4261 |
| 28 | Folder trust | cart | project settings with a hook; start; answer No, then restart and Yes | Hook is off, then on; the answer is remembered | pass. No: the hook stayed off and `/hooks` said why. Yes: the hook ran. A third start did not ask again |
| 29 | MCP, real server | cart | `.mcp.json` with a published stdio server; `/mcp`; a task that needs one of its tools | Tools are listed; the call asks first; the result is used | defect, then pass. `@modelcontextprotocol/server-everything` over stdio: tools listed by `/mcp`, the call asked first, `echo` returned "Echo: hello heyho". The model's first call had no arguments and still asked for approval; fixed in 85b4261 |
| 30 | MCP rule | cart | "don't ask again" for that server, call again | No second prompt | pass. After "don't ask again" for the server, a new session called `get-sum` without asking and got 42 |
| 31 | Skill | cart | a `changelog` skill; `add a changelog entry for discount` | The model reads the skill file and follows its format | pass. The model read `.heyho/skills/changelog/SKILL.md` first and wrote the entry in the skill's format |
| 32 | Subagent | big | a `reviewer` agent; `have the reviewer check src/diff.ts` | Subagent lines are indented; its report comes back; it edits nothing | defect, and slow. The subagent ran, its tool lines were indented, and it edited nothing. But the model thought until the reply hit the output limit (about 7 minutes each time), twice, so the subagent was stopped and the main agent did the review itself: 19 minutes in all for a 70-line file. The main agent alone does the same on this prompt, so it is not the subagent path. Fixed in 4355013: thinking that ran to the limit is no longer fed back into the prompt (16k tokens). Not fixed: nothing stops the thinking sooner; see the questions below |
| 33 | Custom command | cart | `.heyho/commands/review.md` with `$ARGUMENTS`; `/review src/cart.js` | The file is reviewed, nothing edited | pass. The command's text was sent with the file name filled in; one issue reported, nothing edited |
| 34 | Project instructions | cart | `AGENTS.md`: "Always run npm test after an edit"; ask for an edit | Tests are run without being asked | pass. `npm test` run after the edit without being asked. Weak evidence on its own, since the model often does that anyway; a run with "Always answer in French" earlier the same day was answered in French |
| 35 | Notes across sessions | cart | `remember that the discount codes are case-sensitive`; `/clear`; `what do you know about discount codes?` | The note is written to the notes file and used in the new conversation | defect, then pass. Asked to remember something, the model read the missing notes file, was told to search with a glob, and ran `find`, `mkdir` and `ls`, each asking for approval. Fixed in 8725f4a. Rerun: note written in 3 steps unasked, and after `/clear` the question was answered from it in 1 step with no reads |
| 36 | Undo | cart | an edit, then `/undo` | File is back; the model is told on the next turn | not run |
| 37 | Rewind | cart | three turns with edits; `/rewind` to the second, files and conversation | Files and conversation are back; the message is in the input | not run |
| 38 | Compact | big | a long reading session, then `/compact`, then a follow-up question | The follow-up is answered from the notes or by rereading | not run |
| 39 | Automatic shortening | big | keep reading large files until the context passes 85% | Shortens on its own and carries on with the task | not run |
| 40 | Resume | cart | `/rename`, `/exit`, `--resume <name>`, a follow-up | The follow-up uses the earlier conversation | not run |
| 41 | Queue and interrupt | cart | type a second message mid-turn; Esc during a long reply | Queued message runs next; Esc stops and keeps the text | not run |
| 42 | Shell escape | cart | `!git log --oneline`, then `what was the last commit?` | The model has seen the output | not run |
| 43 | File mention | big | `explain @src/compact.ts` | The file is read without a search first | not run |
| 44 | Headless formats | cart | `--json`, `--output-format stream-json`, `-p` with stdin | Valid JSON; events per line; stdin is used | not run |
| 45 | Headless tool limits | cart | `--tools read,search "fix the bug in discount"` and `--allowed-tools "bash(npm test *)" --mode dontask "run the tests"` | First cannot edit and says so; second runs only the tests | not run |
| 46 | Step limit | big | `--max-steps 3 "find every TODO and list them"` | Stops at the limit with a clear status | not run |
| 47 | Settings | cart | `editorMode: vim`, `theme: none`, a `statusLine` command | Vim keys work; no colour codes; status line shows the command's output | not run |
| 48 | Bug fix, multi-file | big | break `diffLines` in a copy (off-by-one in hunk line numbers); `the diff line numbers are wrong; find and fix it` | The failing test is found, the fix is right, the suite passes | not run |
| 49 | Feature, multi-file | big | `add a /stats command that shows tool call counts for this session, with a test` | Command, help entry and test added; suites pass | not run |
| 50 | Refactor | big | `move the secs helper out of ui.ts into its own file and update imports` | Type check and tests pass after | not run |

## Defects found

| Scenario | Defect | Fix | Test |
|---|---|---|---|
| 18 | A read-only command asked for approval when its single-quoted pattern held a backslash | df8e104 | `test/ui.test.ts`, the command-splitting test |
| 19 | A read-only command ending in `2>/dev/null` or `2>&1` asked for approval | 41c27b6 | same test |
| 20 | A session stopped at 40 steps on a four-file change | 41c27b6: 100 steps a turn in a session, 40 kept for task runs | none: a default |
| 20 | At the step limit the summary was a tool call printed as raw text | 41c27b6 | `test/loop.test.ts` "a wrap-up that is another tool call written as text is replaced by a plain note" |
| 20 | The checklist was sent unmarked each time, so nothing was ticked | 41c27b6: the tool's reply says how to tick an item | `test/extra-tools.test.ts`, the checklist test |
| 22 | `/tasks` showed `cd /long/path…` in place of the program's name | 69f55f6 | `e2e/screen.test.ts` "/tasks names the program, not the cd to the project folder the model put in front of it" |
| 23 | Fetched pages lost their title | 69f55f6 | `test/extra-tools.test.ts`, the HTML-to-text test |
| 25 | A block by the user's hook read to the model like a refusal from the remote | 69f55f6 | `e2e/hooks.test.ts`, the two block tests |
| 27 | A Stop hook sent the model back to work with nothing shown to the user | 85b4261 | `e2e/hooks.test.ts` "a Stop hook that exits 2 sends the model back to work, at most three times" |
| 29 | An MCP call with no arguments asked for approval before failing | 85b4261 | `e2e/mcp.test.ts` "a call that leaves out required arguments gets the schema back without asking the user" |
| 35 | Reading a notes file that did not exist yet sent the model searching the disk | 8725f4a | `test/tools.test.ts` "a notes file that is not there yet says to create it, not to go looking for it" |
| 32 | Thinking that ran to the output limit was replayed into the next prompt | 4355013 | `test/loop.test.ts` "a reply that was all thinking and hit the output limit is not replayed, and the model is told to answer" |

## Model behaviour recorded

- Scenario 9: asked for tax with rounding, the model also rounded the discount, which nobody asked for.
- Scenario 10: after the first refusal the model tried `git rm` and then plain `rm` before telling the user. The refusal text already says to carry on without the action.
- Scenario 15: when the write outside the folder failed, the model wrote the file inside the working folder instead, unasked, and reported both facts.

- Scenario 20: the model named a field `quiet` on a class that already had a `quiet()` method, and found it from the type check. It also tried `cat -A`, which macOS does not have.
- Scenario 20: to test its own work the model ran heyho inside heyho. With one server slot, each nested run evicts the outer session's cached prompt, so the next outer step waited over a minute.

- Scenario 27: told not to edit the tests, the model edited a test anyway once the Stop hook insisted the suite pass. The two instructions conflicted.

## Questions for Ega

- Scenario 13: "don't ask again" offers a rule for every `node` command. `node -e` runs any code, the same reason `sh` was taken off that list. `python`, `ruby`, `perl`, `bun` and `deno` are the same. Taking them off changes a permission default, so it waits for a decision.
- Scenario 19: `echo` is not on the list of commands that never ask, so `ls x || echo "none"` still asks. Adding it changes a permission default.
- Still open, cosmetic: a `read` of the project folder itself shows the absolute path in the tool line.
- Scenario 25: `git branch --show-current`, `git remote -v` and `git config --get` are read-only but ask. Adding them to the commands that never ask changes a permission default.
- Still open, cosmetic: the approval for a background command does not say it will run in the background.
- Scenario 32: asked to find bugs in a short file, Qwen3.6 thinks until the 16,384-token output limit, about 7 minutes at 40 tokens a second, and may do it twice. A cap on thinking per reply (stop the reply at, say, 4,000 thinking tokens and ask again with thinking off) would bound this at under 2 minutes. It changes how the model runs, so it needs an eval run on tasks 01, 07 and 08 before it stays. Planned as its own batch after pass 1.
