---
name: scryer-dailies
description: "Use for Scryer Daily summaries, session recording, save cadence, and deciding what belongs in Dailies versus an active project ticket."
---

# Scryer Dailies

Scryer Dailies are PM tasks used to capture Pi session summaries and daily work logs. They are separate from the active project ticket, although the recorder can use the selected project as the daily target when appropriate.

## Main command

Save a recorder summary:

```text
/save
```

This writes a Scryer recorder summary to the Daily PM ticket. The extension also autosaves on idle/token thresholds.

## What belongs in Dailies

Include:

- what the session worked on
- important decisions
- files/repos touched
- commands/checks run
- blockers and follow-ups
- relationship to active project/ticket

Do not include:

- long raw logs unless needed
- secrets or credentials
- every tiny command/output
- invented ticket/project details

## Suggested summary format

```markdown
# Pi Daily Summary

## Work performed
- ...

## Decisions / findings
- ...

## Validation
- ...

## Follow-ups
- ...
```

The extension generates summaries automatically; use this structure as a mental model when judging whether a save is useful.

## Save cadence

Save at natural checkpoints:

- before ending a session
- after completing a meaningful chunk
- after debugging that produced reusable findings
- before switching projects/tickets
- when the user asks to save or checkpoint PM state

Avoid repeatedly saving after trivial edits.

## Dailies vs active ticket

Use:

```text
/update
```

for the active ticket's description/state.

Use:

```text
/ac
```

for a progress/comment update on the active ticket.

Use:

```text
/save
```

for session/day summary in Dailies.

## No active ticket

It is OK to save Dailies without an active ticket. If no project/ticket exists, continue with the explicit user/session decision and save useful session context.

## Troubleshooting

Check context:

```text
/deets
```

If Scryer is unreachable, report the default tailnet endpoint (`http://100.105.192.98:43210`) and ask whether to continue without saving or configure another `SCRYER_PM_URL`. Do not substitute `localhost` for Scryer PM unless the user explicitly asks.
