---
name: find-ticket
description: "Use when the user refers vaguely to work and wants the relevant Scryer ticket found, selected, inspected, updated, or commented on."
---

# Find a Scryer Ticket

Use this skill when the user says things like:

- "find the auth bug ticket"
- "what was that onboarding thing?"
- "use the ticket from yesterday"
- "switch to the Scryer Io notebook task"
- "which ticket should this work go on?"

## First check current context

Start with:

```text
/deets
```

If the active project/ticket already matches the user's request, use it. Do not switch context unnecessarily.

## Prefer repo/project context

If working inside a repo, prefer the Scryer project that matches the repo. Use:

```text
/pp
```

Then inspect/pick tickets in that project:

```text
/tp
```

The ticket picker supports typing to filter in the UI. Use that before doing direct API exploration.

## Direct search fallback

If the picker is insufficient or the user asks for search, use the Scryer API at the tailnet address `http://100.105.192.98:43210`. Do not use `localhost` or `127.0.0.1` for Scryer PM unless the user explicitly asks.

List projects:

```bash
curl -s http://100.105.192.98:43210/api/projects
```

List tasks in a likely project:

```bash
curl -s 'http://100.105.192.98:43210/api/tasks?project_id=<project-id>'
```

Search locally with `jq` when available:

```bash
curl -s 'http://100.105.192.98:43210/api/tasks?project_id=<project-id>' \
  | jq '.[] | {id,title,status,updated_at,description_md}'
```

Use case-insensitive title/description matching. Prioritize:

1. active repo's matched Scryer project
2. open tickets over closed tickets
3. recently updated tickets
4. exact title/tag matches
5. semantic matches in description

## Before selecting or modifying

When there is ambiguity, show 2-5 likely matches with title, status, project, and why it matches. Ask the user to choose.

Do not update or comment on a ticket just because it was found. Distinguish these actions:

- find/identify ticket
- select as active ticket
- update ticket description
- add comment
- save daily summary

## Selecting the ticket

If the user wants it active, prefer the UI path:

```text
/pp
/tp
```

If the current extension does not expose direct selection by ID, tell the user the matching title and use the ticket picker filter.

## No match

If no matching ticket is found, ask whether to:

- create a new ticket with `/tp` then "Create a new ticket"
- continue without a ticket for this session
- save only to Dailies with `/save`

Do not invent a ticket ID.
