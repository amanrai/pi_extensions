---
name: scryer
description: "Use when working in Pi with Scryer PM: selecting projects/tickets, understanding the Scryer API endpoint, saving session summaries, updating tickets, adding comments, or checking Scryer recorder context."
---

# Scryer PM in Pi

Scryer is Aman's project-management system. Pi has a Scryer extension installed that connects the current coding session to Scryer projects, tickets, daily work logs, and session summaries.

## API

Default Scryer PM API base URL:

```text
http://100.105.192.98:43210
```

This can be overridden with:

```bash
SCRYER_PM_URL=<url>
```

Do not ask the user for the API URL unless the default is unreachable or they explicitly want to use another Scryer instance.

## Default workflow

At the beginning of meaningful coding work:

1. Let the Scryer extension establish project/ticket context.
2. If no project is selected, use `/pp` or `/project-picker`.
3. If a project is selected but no ticket is selected, use `/tp` or `/ticket-picker`.
4. If the user says there is no ticket for the work, continue without one; daily summaries can still be saved.
5. Use `/deets` when you need to inspect the current Scryer context.

During work:

- Treat the active Scryer project/ticket as the task context.
- Keep implementation decisions aligned with the selected ticket.
- Do not repeatedly ask what Scryer is or where its API is.

At natural checkpoints:

- Use `/update` or `/ut` to update the selected ticket from the current session without writing a daily summary.
- Use `/ac` to add a summarized comment to the selected ticket.
- Use `/save` to save a recorder summary to the Dailies PM ticket.

## Commands

Project selection:

```text
/pp
/project-picker
/pick-project
```

Ticket selection:

```text
/tp
/ticket-picker
/pt
/pick-ticket
```

Ticket updates/comments:

```text
/ut
/update
/update-ticket
/ac
/add-comments
```

Recorder/context:

```text
/deets
/save
/cockpit
/modal-config
```

## Behavior expectations

- Prefer using the installed Scryer Pi commands over direct API calls for normal project/ticket/session workflow.
- Use direct API calls only when specifically debugging Scryer itself or when the extension command surface is insufficient.
- If Scryer is unreachable, tell the user the default endpoint failed and ask whether to continue without Scryer context or use another `SCRYER_PM_URL`.
- If the active project/ticket seems wrong, ask before changing it.
- Avoid noisy Scryer updates; update/save at meaningful checkpoints or when the user asks.

## Direct API reference

Known extension behavior uses these endpoints:

- `GET /api/projects` — list projects
- ticket/task lookup and updates are handled by the extension internals; prefer the commands above unless debugging.

When direct API exploration is necessary, start with:

```bash
curl -s http://100.105.192.98:43210/api/projects
```
