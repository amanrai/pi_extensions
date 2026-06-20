---
name: scryer-api
description: "Use when direct Scryer PM backend/API access is needed: checking health, listing projects/tasks, debugging PM connectivity, or making curl/fetch calls instead of normal Pi Scryer commands."
---

# Scryer PM API

Use this skill when direct backend access is required. For normal project/ticket/session workflow, prefer the installed Pi commands from the `scryer` skill.

## Base URL

Default API base URL — use the tailnet address, not localhost:

```text
http://100.105.192.98:43210
```

If setting Pi extension behavior explicitly, use the tailnet address:

```bash
SCRYER_PM_URL=http://100.105.192.98:43210
```

Do not use `localhost` or `127.0.0.1` for Scryer PM unless the user explicitly asks to target a local-only instance.

## Health check

```bash
curl -s http://100.105.192.98:43210/healthz
```

If unreachable, report that the default Scryer tailnet endpoint is unavailable. The extension may offer to start Scryer with:

```bash
scryer up --no-open
```

## Known endpoints

Projects:

```bash
curl -s http://100.105.192.98:43210/api/projects
curl -s http://100.105.192.98:43210/api/projects/<project-id>
```

Task types:

```bash
curl -s 'http://100.105.192.98:43210/api/task-types?project_id=<project-id>'
```

Tasks/tickets:

```bash
curl -s 'http://100.105.192.98:43210/api/tasks?project_id=<project-id>'
curl -s http://100.105.192.98:43210/api/tasks/<task-id>
```

Create task:

```bash
curl -s -X POST http://100.105.192.98:43210/api/tasks \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Task title",
    "project_id": "<project-id>",
    "task_type_id": "<task-type-id>",
    "status": "in_execution",
    "description_md": "# Summary\n\nDetails",
    "tag_names": ["pi"],
    "created_by_role": "pi",
    "created_by_instance_key": "manual-api"
  }'
```

Patch task:

```bash
curl -s -X PATCH http://100.105.192.98:43210/api/tasks/<task-id> \
  -H 'Content-Type: application/json' \
  -d '{
    "description_md": "Updated markdown",
    "status": "in_execution",
    "tag_names": ["pi"]
  }'
```

Comments:

```bash
curl -s -X POST http://100.105.192.98:43210/api/comments \
  -H 'Content-Type: application/json' \
  -d '{
    "task_id": "<task-id>",
    "author_role": "pi",
    "author_instance_key": "manual-api",
    "body_md": "Markdown comment",
    "body_format": "markdown"
  }'
```

## Status conventions

Common statuses observed in the Pi extension:

- `unopened`
- `in_execution`
- `ready_for_human_review`
- `human_reviewed_and_closed`

Prefer open work statuses for active tickets. Do not close a ticket unless the user asks or the workflow clearly calls for it.

## Safety

- Prefer `/pp`, `/tp`, `/update`, `/ac`, `/save`, and `/deets` for normal use.
- Before modifying a ticket found by search, confirm it is the intended ticket.
- Avoid direct writes when the Pi extension can perform the action with session context.
