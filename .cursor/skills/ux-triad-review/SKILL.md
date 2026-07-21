---
name: ux-triad-review
description: >-
  Runs A3Panel’s three-role UX loop — operator (find confusing workflows),
  developer (implement fixes), end-goal reviewer (check adherence). Use when the
  user asks for a UX review, triad review, confusing-workflows pass, operator
  walkthrough, or to validate UI changes against the product goal.
---

# A3Panel UX triad review

Orchestrate three roles against the live codebase (UI code + copy). Do **not** claim a real browser click-through unless the user is driving the UI.

Read [end-goal.md](end-goal.md) and [roles.md](roles.md) before starting.

## When to run

- User asks for UX / triad / operator review
- Large UI change and user wants a pass before calling it done
- User says “go with the three agents” / “confusing workflows”

## Loop

```
Progress:
- [ ] 1. Operator — findings only
- [ ] 2. End-goal reviewer — prioritize findings
- [ ] 3. Developer — implement approved fixes (or propose if user said review-only)
- [ ] 4. End-goal reviewer — verify diffs
- [ ] 5. Report to user
```

### 1. Operator (explore)

Launch an explore/generalPurpose subagent with the **Operator** prompt from [roles.md](roles.md).

Scope (default unless user narrows):

- Dashboard host card actions
- Agent setup wizard
- Mods & server files panel
- Instance page (profile apply + host link)
- Headless groups / reachable address copy
- Apply profile modal

Return: ranked list of confusing spots (path → what a new admin might think → why it’s wrong).

### 2. End-goal reviewer (prioritize)

Using [end-goal.md](end-goal.md), mark each finding:

- **Must fix** — violates a principle or blocks a core workflow
- **Should fix** — clear confusion, low risk
- **Defer** — edge case / needs product decision

Do not implement in this step.

### 3. Developer (change)

Only for **Must fix** / **Should fix** unless the user said review-only.

- Smallest UI/copy change that removes the confusion
- Match existing patterns in `web/src`
- No drive-by refactors; no commits unless the user asked

### 4. Re-review

Second pass on the diff only: does it still match [end-goal.md](end-goal.md)? Any new misplaced actions?

### 5. User report

Keep it short:

1. What was confusing (top 3–5)
2. What changed (or what you’d change if review-only)
3. What was deferred and why

## Parallelism

Run Operator exploration as a Task subagent. Parent agent (or a second subagent) does end-goal prioritization. Developer work stays in the parent unless the user wants an isolated implementer Task.

## Out of scope

- Inventing features not implied by findings
- Rewriting README unless copy is the finding
- Live SteamCMD / agent runs (code-path reasoning only)
