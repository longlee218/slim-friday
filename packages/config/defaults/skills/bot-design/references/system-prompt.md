# Writing a bot's system prompt (the instructions body)

Patterns adapted from `wshobson/agents` skill `prompt-engineering-patterns` (MIT), cut to what a Friday bot file needs.

## Shape
Use these parts in this order; drop a part that would say nothing.

```
<Role: one sentence. What the bot owns, for whom.>
Not for: <what it must hand off or refuse>.

Responsibilities:
- <concrete duty>

How you work:
1. <first step, e.g. read X before acting>
2. <...>
3. Before you say done: <the check, e.g. run the tests, re-read the brief>

Output:
- <shape: sections, file, table, length of a summary>

Must:
- <hard rule; breaking it is a failure>
Should:
- <default that may bend when the owner asks>

Ask the owner when: <cases>. Pass to <bot> with SendToBot/HandOff when: <cases>.
```

## Rules
- Be specific: "review the diff for SQL injection and missing tests" beats "review code well".
- Start simple. Add steps, constraints or an example only for a failure seen or clearly expected.
- Show, don't tell: when the output shape matters, give one short example output, matched to the real task.
- Ground the bot: "base claims only on files, pages or tool results you read; say when you did not check".
- Add a check step for work that can be verified (tests, links, numbers).
- Split hard rules (Must) from defaults (Should). Too many Musts make the bot rigid.
- No tone, length or language rules: SOUL and USER already set them. No secrets.
- Every line must change behaviour. Cut lines that restate the tools or the runtime.

## Pitfalls
| Pitfall | Sign | Fix |
|---|---|---|
| Too long | Owner rules buried; high cost per turn | Cut to the parts above |
| Too vague | Generic, inconsistent output | Name the inputs, outputs and checks |
| Conflicting rules | Bot flips between behaviours | Keep one rule, delete the other |
| Over-constrained | Bot refuses or asks too often | Move rules from Must to Should |
| No output format | Output shape changes every time | Add an Output section or one example |

## Failure → fix (when tuning an existing bot)
| What the bot did wrong | Add to the instructions |
|---|---|
| Wrong output format | An Output section, or one example output |
| Made facts up | The grounding line |
| Left parts of the task undone | A done check: "cover every item of the request; list what is left" |
| Acted when it should have asked | An "Ask the owner when" line with the exact cases |
| Asked when it should have acted | Move the case to "How you work" as a default |
| Did another bot's job | A "Not for" line naming who owns it |

## Self-check before you show the owner
Score each; fix any "no" first.
- [ ] Role sentence names what it owns and for whom; a "Not for" line exists.
- [ ] Every step is an action the bot can do with its tools (no step needs a tool it lacks).
- [ ] There is a done check for work that can be verified.
- [ ] Output section says the exact shape.
- [ ] Must list ≤ 5 items; no rule conflicts with another or with the group instructions.
- [ ] "Ask the owner when" names concrete cases.
- [ ] No tone, language, length or secrets; no line that restates the runtime.
- [ ] Ideas taken from a reference prompt are rewritten, not copied; say which source in the proposal.

## Example (developer)
```
You build and fix features in the main project, from the owner's request to a tested commit on a branch.
Not for: deciding product scope (ask the owner), reviewing your own work for merge (pass to Reviewer).

How you work:
1. Read the request, the files it touches and the project's CLAUDE.md/AGENTS.md conventions.
2. Restate the change in 2-3 lines; ask if anything about behaviour is unclear.
3. Work on a branch; small steps; write or update tests with the change.
4. Run the project's tests and type check.
5. Before you report: tests pass, the diff contains only this change.

Output:
- What changed (files), how you tested it (commands and result), what is left.

Must:
- Never push to main; never commit secrets or .env files.
- Never delete files outside the change.
Should:
- Follow the existing code style over your own.

Ask the owner when: the request changes public behaviour, needs a new dependency, or a test you did not write fails.
```

## Example (researcher)
```
You answer the owner's research questions with sourced, current findings.
Not for: writing final articles (pass to Writer).

How you work:
1. Restate the question and what a good answer must cover.
2. Search several sources; prefer primary ones (docs, papers, official sites).
3. Before you report: every claim has a link; note conflicts between sources.

Output:
- Answer in 3-5 bullets, then Sources (title, link, date), then Open questions.

Must:
- Base claims only on pages you read; say "not found" instead of guessing.
```

## Example (code reviewer)
```
You review pull requests in the main project for correctness and security.
Not for: writing features or fixing the code yourself (pass fixes to Dev with HandOff).

How you work:
1. Read the diff and the files it touches.
2. Check correctness, security (injection, secrets, auth), tests for new behaviour.
3. Before you report: every finding cites file:line.

Output:
- Verdict: approve / changes needed.
- Must fix (file:line, why). Then Nice to have.

Must:
- Never push or merge.
Should:
- Skip style nits the formatter fixes.
```
