---
name: workflow
description: Master workflow of a code task: triage, understand, plan, TDD implement, verify with evidence, deliver, report. Use at the start of every code task (plan or execute run) to pick the right skill for each step.
---

# Workflow of a code task

Owner-editable. The app gates the plan (owner approval), the PR and the result; this skill only sets how you work between those gates.

## Steps

1. Triage
   - Name the task type: bug, feature, refactor, tests only, question. A pure question is answered, not implemented.
   - Pick the repo from the registry. Check the repo memory and AGENTS notes for its test command and conventions.
2. Understand
   - Read the code before judging it. Cite what you rely on as `path:line`.
   - Unclear request: ask the owner only as the ask rules allow (batched, limited number of calls); otherwise choose a default and write it down as an assumption.
3. Plan (plan stage)
   - Use `superpowers:writing-plans` for the plan format (Global Constraints, then `### Task N` per task).
   - Keep tasks small and independent. State the repo line and assumptions. Submit the plan; do not implement.
4. Implement (execute stage)
   - Test first: write a failing test, see it fail for the right reason, make it pass, refactor. Smallest change that works.
   - One short conventional commit per task through the git tools. No scope beyond the plan: if the plan no longer fits, stop and explain.
5. Verify
   - Run the repo's `testCommand` (and typecheck/lint when the repo has them) yourself. Read the output.
   - Paste the evidence: the command and the pass/fail line. No "should work", no claim without a fresh run.
6. Deliver
   - Stop after the report. You do not push, open the PR or merge: the app gates the PR and the result.

## Which skill when

| Situation | Skill |
|---|---|
| New feature, unclear design, several ways to do it | `superpowers:brainstorming` (questions go to the owner through the ask tool, within the ask limit) |
| A spec or request needs a multi-step plan | `superpowers:writing-plans` |
| An approved plan exists, execute stage | `superpowers:executing-plans` |
| Writing any code or a fix | `superpowers:test-driven-development` |
| About to say "done", "fixed" or "passes" | `superpowers:verification-before-completion` |
| A bug, a failing test or unexpected behavior | `superpowers:systematic-debugging` |

Only the skills in the skill list are loaded. A skill that points at one that is not listed, or at a worktree, branch or merge step the app does itself, cannot be followed to the letter: apply its intent to this run as the run rules say, or skip the step.

## Definition of done

- The change does what the plan says, nothing more.
- New or changed behavior has a test that failed before and passes now.
- The repo's test command passes in a fresh run; typecheck and lint pass when the repo has them.
- Everything committed in small commits; no stray files, no secrets, no debug output.
- Assumptions and open questions are written down.

## Report format

End every run with:

- `TL;DR`: at most 3 lines. What changed and whether it is verified.
- `Changes`: bullets per file or area, with `path:line` for the key spots.
- `Verification`: each command run and its result (pasted line).
- `Open questions`: what the owner should decide or check; "none" if empty.

Then, in the execute stage, the `Memory:` section as the run rules say.
