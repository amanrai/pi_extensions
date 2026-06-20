---
name: scryer-ticket-workflow
description: "Use when doing implementation work against a Scryer PM ticket: interpreting scope, maintaining ticket context, updating ticket descriptions, and adding progress comments."
---

# Scryer Ticket Workflow

Use this skill when coding or planning work that is tied to a Scryer ticket.

## Establish context

1. Check context:

```text
/deets
```

2. If no project is selected:

```text
/pp
```

3. If no ticket is selected and the work should be ticketed:

```text
/tp
```

If the user says the work is exploratory or no ticket exists, continue without an active ticket and use Dailies for summaries.

## Understand the ticket

When a ticket is active, treat it as the source of scope. Infer and track:

- objective
- acceptance criteria
- constraints/non-goals
- files/components likely involved
- validation steps
- open questions

Ask before expanding scope beyond the ticket.

## During implementation

- Keep changes aligned to the ticket objective.
- Prefer small, verifiable increments.
- Mention blockers and decisions as they occur.
- If the active ticket appears wrong, ask before switching.
- Avoid noisy ticket updates for every small edit.

## Updating the ticket

Use:

```text
/update
```

or:

```text
/ut
```

This updates the selected ticket from the current session without writing a Daily summary.

Good times to update:

- after a meaningful implementation milestone
- after discovering major new constraints
- before handing work to a human
- when the user asks for ticket state to be refreshed

## Adding comments

Use:

```text
/ac
```

Use comments for progress notes, design decisions, blockers, or handoff notes. Prefer a concise format:

```markdown
## Update
- What changed
- Why it changed
- Validation performed
- Remaining work / blockers
```

## Finishing work

Before declaring a ticket done:

- run relevant checks/tests if available
- summarize files changed and behavior changed
- note validation and known limitations
- ask before closing or marking ready for review unless the user explicitly requested it

## Dailies vs ticket updates

Ticket updates describe the state of a specific work item. Dailies summarize the session/day. Use both when appropriate, but do not confuse them:

- `/update` changes the active ticket
- `/ac` comments on the active ticket
- `/save` writes/updates the Daily recorder summary
