---
name: workflow
description: Master workflow of a task: triage, understand, design and plan, owner approval, TDD implement, verify with evidence, finish, report. Use at the start of every dev task to pick the right skill for each step.
---

# Workflow of a task

Owner-editable. One discipline for the whole run; nothing in the app enforces the order, so follow it yourself. The owner sees only Discord: every approval and choice goes through the ask tool.

## Steps

1. Triage
   - Name the task type: bug, feature, refactor, tests only, research, question. A pure question is answered, not implemented.
   - Pick the repo from the registry. Check the repo memory and AGENTS notes for its test command and conventions.
2. Understand
   - Read the code before judging it. Cite what you rely on as `path:line`.
   - Unclear request: ask the owner only as the ask rules allow (batched, limited number of calls); otherwise choose a default and write it down as an assumption.
3. Design and plan
   - Unclear design or several ways to do it: `superpowers:brainstorming`.
   - Use `superpowers:writing-plans` for the plan format (Global Constraints, then `### Task N` per task). Keep tasks small and independent. State the repo line and assumptions.
4. Owner approval
   - Show the plan and get the owner's approval with the ask tool. Do not change files before it. A research or design request with no change needs no approval: the plan is the result.
5. Implement
   - Test first: write a failing test, see it fail for the right reason, make it pass, refactor. Smallest change that works.
   - Work on a branch; a git worktree is optional (use one when the checkout has other work in progress).
   - Plan with 3 or more tasks: run it with `superpowers:subagent-driven-development` (it brings `superpowers:requesting-code-review` and `superpowers:receiving-code-review`). Fewer than 3 tasks: `superpowers:executing-plans`, inline.
   - One short conventional commit per task with `git`. No scope beyond the plan: if the plan no longer fits, stop and explain.
6. Verify
   - Run the repo's `testCommand` (and typecheck/lint when the repo has them) yourself. Read the output.
   - Paste the evidence: the command and the pass/fail line. No "should work", no claim without a fresh run.
7. Finish
   - Use `superpowers:finishing-a-development-branch`: offer the options (merge, push and open a PR, keep the branch) with the ask tool and act on the owner's choice. Merge, push or PR only after the owner chose it.
8. Report
   - Use the report format below.

## Coding principles

Bias toward caution over speed; for trivial tasks, use judgment.

1. Think before coding
   - State assumptions. Several readings of the request: name them, do not pick one silently. A simpler way exists: say so. Something unclear: stop, name it, ask (within the ask limit).
2. Simplicity first
   - Minimum code that solves the request. No features, abstractions, configurability or error handling nobody asked for. 200 lines that could be 50: rewrite.
3. Surgical changes
   - Touch only what the request needs. Do not reformat, refactor or "improve" adjacent code; match the existing style.
   - Remove only what your change made unused. Pre-existing dead code: mention it, do not delete it.
   - Test: every changed line traces back to the request.
4. Goal-driven execution
   - Turn the task into checks: "fix the bug" = a test that reproduces it, then passes. State a short plan with a check per step and loop until each check passes.

## Which skill when

| Situation | Skill |
|---|---|
| New feature, unclear design, several ways to do it | `superpowers:brainstorming` (questions go to the owner through the ask tool, within the ask limit) |
| A spec or request needs a multi-step plan | `superpowers:writing-plans` |
| An approved plan of fewer than 3 tasks | `superpowers:executing-plans` |
| Writing any code or a fix | `superpowers:test-driven-development` |
| The work is verified and the owner must choose merge, PR or keep | `superpowers:finishing-a-development-branch` |
| About to say "done", "fixed" or "passes" | `superpowers:verification-before-completion` |
| A bug, a failing test or unexpected behavior | `superpowers:systematic-debugging` |

Only the skills in the skill list are loaded. A skill that points at one that is not listed cannot be followed to the letter: apply its intent to this run as the run rules say, or skip the step.

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
