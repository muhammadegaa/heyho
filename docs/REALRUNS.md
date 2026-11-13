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
| 36 | Undo | cart | an edit, then `/undo` | File is back; the model is told on the next turn | pass. `/undo` put the file back (git clean); asked what codes exist, the model read the file again and listed only SAVE10 |
| 37 | Rewind | cart | three turns with edits; `/rewind` to the second, files and conversation | Files and conversation are back; the message is in the input | pass. After three edits, rewinding to before the second restored the file (only CODEA left) and the conversation (the model listed HALF as undone and CODEA as present); the message was back in the input box |
| 38 | Compact | big | a long reading session, then `/compact`, then a follow-up question | The follow-up is answered from the notes or by rereading | pass (after the fixes for 39). Two files read, `/compact`, then a follow-up answered from the notes in one step with no reads. The notes named the request, both files, what each does and the key class |
| 39 | Automatic shortening | big | keep reading large files until the context passes 85% | Shortens on its own and carries on with the task | defects; partly confirmed. Four runs. Run 1: parallel reads took the prompt to 113% of the context and the user saw the server's raw error (dc7ae3a). Run 2: shortened without error, but the notes were ten tool calls written as text and the task was lost (dc7ae3a). Run 3: the task was kept, but both tries at notes thought for 7 minutes and wrote nothing (0ef6490). Run 4: shortened once with notes written, then filled the context again and the turn ended with "type /compact" (e810d49, scripted test only; not rerun on the real model). The task itself never finished in any run: the model reads all 37 files before counting anything, which cannot fit in 64k |
| 40 | Resume | cart | `/rename`, `/exit`, `--resume <name>`, a follow-up | The follow-up uses the earlier conversation | pass, model. `--resume discount` reopened the named session with the whole conversation (checked in the session file). Asked which code it added last, the model said HALF; the right answer was CODEA |
| 41 | Queue and interrupt | cart | type a second message mid-turn; Esc during a long reply | Queued message runs next; Esc stops and keeps the text | pass. The message typed mid-turn showed as queued and ran next (README changed). Esc stopped a long reply, kept the text, and the summary line had no stale step count |
| 42 | Shell escape | cart | `!git log --oneline`, then `what was the last commit?` | The model has seen the output | pass. After `!git log --oneline`, the model gave the right hash and message without running anything |
| 43 | File mention | big | `explain @src/compact.ts` | The file is read without a search first | pass. The mentioned file was read directly (2 steps, no search) and explained correctly |
| 44 | Headless formats | cart | `--json`, `--output-format stream-json`, `-p` with stdin | Valid JSON; events per line; stdin is used | pass. `--json`: one object, status done, reply `2`. `--output-format stream-json`: five lines, each valid JSON, from `start` to `result`. `-p` with piped input: the input was used |
| 45 | Headless tool limits | cart | `--tools read,search "fix the bug in discount"` and `--allowed-tools "bash(npm test *)" --mode dontask "run the tests"` | First cannot edit and says so; second runs only the tests | defect, then pass. `--allowed-tools "bash(npm test *)" --mode dontask`: tests ran, `ls -la /etc` was refused. `--tools read,search` with a fix request: the model read the file ten times and was stopped by the repeat guard without saying it could not edit; fixed in 9148c14. Rerun: three steps, said it could not edit and gave the exact change |
| 46 | Step limit | big | `--max-steps 3 "find every TODO and list them"` | Stops at the limit with a clear status | pass. Sent with a five-file reading task: stopped after three steps with `[step_limit]` and exit code 0. The wrap-up summarised the file it had reached, not what was left |
| 47 | Settings | cart | `editorMode: vim`, `theme: none`, a `statusLine` command | Vim keys work; no colour codes; status line shows the command's output | defect, then pass. From the user's settings file: the status line showed `branch:master`, `theme: none` left no colour codes on screen, and the footer showed INSERT and NORMAL. With vim keys, Esc then `x` deleted nothing; fixed in 87a834a |
| 48 | Bug fix, multi-file | big | break `diffLines` in a copy (off-by-one in hunk line numbers); `the diff line numbers are wrong; find and fix it` | The failing test is found, the fix is right, the suite passes | pass. With `newNo` planted at 0 in `src/diff.ts` (3 of 4 diff tests failing) and only the symptom described, the model found the line, fixed it and ran the diff tests: 1 minute, 6 steps, 4 pass (checked outside heyho) |
| 49 | Feature, multi-file | big | `add a /stats command that shows tool call counts for this session, with a test` | Command, help entry and test added; suites pass | pass. `/stats` added to the command list and the handler, with an e2e test modelled on its neighbours: 14 steps, 13 lines changed in 2 files. Type check clean and the new test passes (both checked outside heyho). The checklist's last item was left unticked although the test had been run |
| 50 | Refactor | big | `move the secs helper out of ui.ts into its own file and update imports` | Type check and tests pass after | pass. The helper moved to `src/secs.ts`, imported in three files, both copies removed: 4 minutes, 19 steps. Type check clean and 86 tests pass (checked outside heyho). The model kept a checklist without being asked and ticked every item |

Pass 1 finished on 2026-11-13: 50 scenarios run, 18 defects found and fixed, each with a test except the session step limit (a default). 36 scenarios passed first time. Three fixes are not yet confirmed on the real model and are the first things pass 2 checks: repeated shortening in one turn (39), the Stop hook's note on screen (27), and the MCP call with missing arguments answered without asking (29).

## Pass 2

Every scenario again, on the code with pass 1's fixes, starting with the three fixes that had only a scripted test behind them. Finished 2026-11-13.

Result: one defect, in scenario 39, fixed in 35a37b3. Scenarios 27 and 29 had been run before that fix and were run again after it; both passed. So all 50 scenarios have passed on the code as it stands at 35a37b3 and later, and no later commit touches `src/`. A third pass was not run for that reason: it would repeat 50 passes on unchanged code.

Where pass 2 was faster than pass 1, the cause was fewer approval prompts and no dead ends: the rename (18) took 1 min 48 s against 13 minutes, the new test file (19) 30 seconds, the subagent review (32) 7.5 minutes against 19.

| # | Scenario | Result |
|---|---|---|
| 27 | Stop hook | pass. The screen showed "A Stop hook sent the model back to work: npm test is failing…"; tests passed at the end |
| 29 | MCP, real server | pass. A call with no arguments got the schema back with no approval prompt; only the real call asked |
| 39 | Automatic shortening | defect, then pass. The task was changed so it can finish: one line written to a file after each of 36 files. First run: after 20 files the conversation was shortened and the model's whole notes were one line naming its next step, so the task was lost (35a37b3). Rerun: shortened twice in one turn, all 36 lines written with no duplicates, and the model said DONE with a total. 15 minutes |
| 1 | Read-only question | pass |
| 2 | Edit, ask mode | pass |
| 3 | Decline with a correction | pass. Retried as HALFOFF |
| 4 | Edit, then verify | pass. 3 tests pass; `npm test` did not ask |
| 5 | Saved command rule | pass |
| 6 | Auto mode | pass. No `subtotal` left; 3 tests pass |
| 7 | Plan mode | pass. No changes |
| 8 | Plan, keep planning | pass. Still no changes |
| 9 | Plan, carry out | pass. `tax` added; 3 tests pass |
| 10 | dontask mode | pass. README still there |
| 11 | Deny rule | pass. File still there |
| 12 | Allow rule from settings | pass. Trust question, then `node -e` ran without asking |
| 13 | Chained command | pass. Same as pass 1 |
| 14 | Yolo, headless | pass. Test added; 3 pass |
| 15 | Sandbox holds | pass. Nothing written to the home folder; this time the model asked before writing elsewhere |
| 16 | Search tool | pass. 50 seconds |
| 17 | Large file read | pass. Four pages, no repeats |
| 18 | Failed edit recovery | pass. 1 min 48 s against 13 minutes in pass 1; the only approval asked was `bun run typecheck`. No `secs` left, type check clean |
| 19 | Write a new file | pass. 30 seconds; asked only for `bun test`; both tests pass |
| 20 | Checklist | pass. 45 steps, all six checklist items ticked, `--quiet` works (reply on stdout, 0 bytes on stderr, type check clean). The clock shows 117 minutes because the Mac slept for 88 of them; about 29 minutes of work. `find src -type f \| sort` still asked (`sort` is one of the open questions) |
| 21 | Question tool | pass, model. Three names offered in plain text again, not through the menu |
| 22 | Background command | pass. The model again set the background flag and added `&`; the job was tracked, answered 200, and `/tasks stop 1` ended it |
| 23 | Web fetch | pass. Title given from the fetch alone |
| 24 | Fetch rule | pass. No second prompt |
| 25 | Hook blocks a tool | pass |
| 26 | Hook after edit | pass |
| 28 | Folder trust | pass. No, Yes, then remembered |
| 30 | MCP rule | pass (run with 29) |
| 31 | Skill | pass |
| 33 | Custom command | pass. Nothing edited |
| 34 | Project instructions | pass. With "Always answer in French", the answer was in French |
| 35 | Notes across sessions | pass. Note written and used after `/clear` in one step. Before writing, the model ran `ls` on the notes folder, which asked because the folder is outside the project |
| 36 | Undo | pass |
| 37 | Rewind | pass. Back to CODEA only, message in the input box |
| 40 | Resume | pass. Reopened by name; the follow-up was answered correctly from the earlier conversation this time |
| 41 | Queue and interrupt | pass |
| 42 | Shell escape | pass. Right hash, nothing run |
| 44 | Headless formats | pass |
| 45 | Headless tool limits | pass. With read and search only: four steps, no edit, said so. `npm test 2>&1` ran under the `npm test` rule; `ls -la /etc` refused |
| 47 | Settings | pass. Status line, no colour codes, and Esc then `x` deleted the last character |
| 32 | Subagent | pass, slow. The subagent read the file and reported back in 7 min 31 s (19 minutes in pass 1), edited nothing. Most of the time is still thinking. Two of the four findings it reported look wrong to me (the hunk code does track the last line added); that is the model's review, not heyho |
| 38 | Compact | pass. Answered from the notes: `src/approve.ts`, class `Approvals` |
| 43 | File mention | pass. Read directly, no search |
| 46 | Step limit | pass. `[step_limit]` after three steps |
| 48 | Bug fix, multi-file | pass. Same one-character fix; 4 diff tests pass |
| 49 | Feature, multi-file | pass. `/stats` with a test, 20 lines in 2 files; type check clean and the test passes |
| 50 | Refactor | pass. One `secs` left, in `src/secs.ts`; type check clean, 86 tests pass |

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
| 39 | Shortening failed with the server's raw error when one step's tool results had already taken the conversation past the limit | dc7ae3a | `test/loop.test.ts` "shortening still works when the conversation is already too big to send…" |
| 39 | The notes kept after shortening were tool calls written as text | dc7ae3a | `test/loop.test.ts` "notes that come back as a tool call are asked for again…" |
| 39 | Writing notes, the model thought to the output limit and wrote nothing | 0ef6490: notes, step-limit summaries and the retry after runaway thinking go without thinking | `test/loop.test.ts`, the shortening and all-thinking tests |
| 39 | A second fill of the context in one turn ended the turn | e810d49: up to three shortenings a turn | `e2e/headless.test.ts` "a long task is shortened more than once in one run and still finishes" |
| 45 | With `--tools` the model was not told which tools it had, and looped on the ones it did | 9148c14 | `e2e/headless.test.ts` "--tools limits which tools the model is offered" |
| 47 | With vim keys, Esc left the cursor past the last character, so `x` deleted nothing | 87a834a | `e2e/screen.test.ts` "vim keys: Esc enters normal mode, motions and deletes work, i returns to typing" |
| 39 (pass 2) | After shortening, the notes left out the task itself | 35a37b3: the user's requests are carried over by heyho in their own words, through any number of shortenings | `test/loop.test.ts` "shortening keeps the system prompt and the model's notes" |

## Model behaviour recorded

- Scenario 9: asked for tax with rounding, the model also rounded the discount, which nobody asked for.
- Scenario 10: after the first refusal the model tried `git rm` and then plain `rm` before telling the user. The refusal text already says to carry on without the action.
- Scenario 15: when the write outside the folder failed, the model wrote the file inside the working folder instead, unasked, and reported both facts.

- Scenario 20: the model named a field `quiet` on a class that already had a `quiet()` method, and found it from the type check. It also tried `cat -A`, which macOS does not have.
- Scenario 20: to test its own work the model ran heyho inside heyho. With one server slot, each nested run evicts the outer session's cached prompt, so the next outer step waited over a minute.

- Scenario 27: told not to edit the tests, the model edited a test anyway once the Stop hook insisted the suite pass. The two instructions conflicted.

- Scenario 44: asked for the first word of "reply with only the first word of this sentence", the model said "this".

## Questions for Ega

- Scenario 13: "don't ask again" offers a rule for every `node` command. `node -e` runs any code, the same reason `sh` was taken off that list. `python`, `ruby`, `perl`, `bun` and `deno` are the same. Taking them off changes a permission default, so it waits for a decision.
- Scenario 19: `echo` is not on the list of commands that never ask, so `ls x || echo "none"` still asks. Adding it changes a permission default.
- Scenario 25: `git branch --show-current`, `git remote -v` and `git config --get` are read-only but ask. Adding them to the commands that never ask changes a permission default.
- Scenario 32: asked to find bugs in a short file, Qwen3.6 thinks until the 16,384-token output limit, about 7 minutes at 40 tokens a second, and may do it twice. A cap on thinking per reply (stop the reply at, say, 4,000 thinking tokens and ask again with thinking off) would bound this at under 2 minutes. It changes how the model runs, so it needs an eval run on tasks 01, 07 and 08 before it stays. Planned as its own batch after pass 1.
- Scenario 39: `find src -type f \( -name "*.ts" -o -name "*.tsx" \) | sort` asks for approval: the escaped brackets make it a command that can't be judged, and `sort` is not on the list of commands that never ask.

## After the two passes

- The approval for a background command now reads "Run a command in the background" (checked on the real model). `e2e/screen.test.ts` "a background command shows in the footer and /tasks…".
- Paths under the home folder, such as the notes file, are shown with `~` in tool lines, approvals and `/tasks`. The long absolute paths seen in the runs were these, not paths inside the project. `test/ui.test.ts` "paths are shown relative to the project, and with ~ under the home folder".
