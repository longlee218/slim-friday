---
name: plan-work
description: Decompose a request into a plan of worker items (keys, roles, briefs, dependencies, risks, acceptance criteria, envelope) for the owner to approve once.
---

# Plan work

You write the plan through the plan tools. The owner approves it once; then the app runs the items one after another.
You are read-only and cannot ask the owner: skip any dialogue or design document from other skills, and put the result
in `CreatePlan`.

## Steps

1. Call `GetProjectContext` (request, locations, finished items) and `GetAgentCapabilities` (roles you may use).
2. Read only what you need in the locations to size the work.
3. Split into items. One item = one worker run with one clear outcome. At most 8 items; fewer is better.
4. Write each brief so the worker needs nothing else: the goal, the files or areas, what "done" means, what not to touch.
5. Add `dependsOn` only where an item needs the output of another. The graph has no cycle.
6. Set the envelope: the locations, risk classes and bounds (max items, max GB) the plan needs, and nothing wider.
7. Call `CreatePlan`. On coded errors, fix them and call again. Report the plan id and version when it is valid.

## Item template

- key: short slug (`design`, `impl-api`); never starts with `planner`
- role: from `GetAgentCapabilities`
- brief: goal, scope, done-when, limits (self-contained)
- location: only when the item works in one
- dependsOn: keys it waits for
- risk: R0 read-only, R1 local and reversible, R2 shared or hard to undo, R3 external effect (an unknown word counts as R2)
- deferredScope: true for a step named now but left for a later plan

## Patterns

- Sequential: research -> implement -> verify, each depends on the one before.
- Iterative: implement one slice, verify it, then the next slice (plan the first slices only, defer the rest).
- Mixed: independent research items first, one implement item that depends on them, one verify item last.

## Acceptance criteria

Two to five checks the owner can see: "tests pass", "the endpoint returns X", "a PR is open". Observable, not "good quality".

## Revising

Read `GetExecutionProgress` and `AnalyzeBlockers`, then `ProposePlanRevision` with add / cancel / modify. Do not redo finished
items. Keep inside the approved envelope; widening it asks the owner again.

## Example 1: small feature

Request: "add a /health endpoint and a test". Items: `impl` (developer, R1, location api), `verify` (developer, R1, depends on `impl`).
Envelope: locations [api], risk [R1], 2 items. Delivery: pr.

## Example 2: research then change

Request: "move the config to env vars". Items: `survey` (scout, R0), `change` (developer, R1, depends on `survey`), `check` (developer, R1, depends on `change`).
Envelope: locations [app], risk [R0, R1], 3 items. Delivery: keep.
