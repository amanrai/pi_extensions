---
name: scryer-pm
description: "Use ONLY on explicit user demand to read or modify Scryer/PM-system records: projects, tickets, stories, tasks, goals, checklist items, comments, blockers, notes, attachments, tags, or repo links. Trigger on phrases like 'look at the ticket', 'update the story', 'find the ticket', 'tell me what the ticket says', 'record this in Scryer/the PM system', or explicit mentions of Scryer/PM system. Do not use for general planning, ordinary code tasks, or casual mentions of projects/tasks/goals."
---

# Scryer PM

Scryer is Aman's API-first project-management system for projects, tickets/stories/tasks, dependencies, comments, goals, notes, attachments, and related collaboration records.

## Activation rule

Use this skill only on explicit user demand to interact with Scryer or PM-system records.

Explicit demand includes:

- "Scryer", "PM system", "project management system"
- "look at the ticket", "find the ticket", "what does the ticket say?"
- "update the ticket/story/task", "add a comment to the ticket"
- "record this", "track this", "create a ticket/story/task" in a PM-record context
- requests involving a specific Scryer project/task/goal/checklist/comment ID

Do not use this skill for:

- general project-management advice
- local code work where "project" means the repo or codebase
- ordinary planning/todo lists outside Scryer
- casual mentions of "task", "project", "goal", "story", or "ticket" without a request to inspect or change a tracked PM record

If the user intent is ambiguous, ask whether they mean Scryer before calling the API.

## Operating principles

- Read before writing. Resolve names/titles to exact IDs before mutation.
- Never guess IDs. If there are multiple plausible records, show the candidates and ask the user to choose.
- Confirm before destructive actions: `DELETE`, bulk edits, moving many tasks, deleting comments/notes/attachments, or changing parent/project relationships.
- Prefer comments for progress/status notes so history is preserved. Use `PATCH` for canonical field changes such as title, description, status, parent, tags, or completion.
- Use minimal PATCH bodies containing only fields that should change.
- When creating records, set actor fields consistently:
  - `created_by_role` / `author_role` / `actor_role`: usually `pi-agent` unless the user specifies otherwise.
  - `created_by_instance_key` / `author_instance_key` / `actor_instance_key`: use a stable local identifier if available; otherwise use `pi`.
- Summarize API results in human terms. Include IDs when they will be useful for follow-up.

## API access

Default base URL:

```text
http://100.105.192.98:43210
```

Prefer environment override if present:

```bash
${SCRYER_API_BASE_URL:-${PI_PM_API_BASE_URL:-http://100.105.192.98:43210}}
```

You may use direct HTTP calls or the bundled helper:

```bash
python skills/scryer-pm/scripts/scryer_api.py GET /api/projects
python skills/scryer-pm/scripts/scryer_api.py GET /api/tasks
python skills/scryer-pm/scripts/scryer_api.py POST /api/comments --json '{"author_role":"pi-agent","author_instance_key":"pi","body_md":"...","task_id":"..."}'
```

Resolve relative paths from the skill directory. If this skill is installed globally, use the actual skill directory path after loading `SKILL.md`.

## What to read next

- For common workflows and decision rules, read `references/workflows.md`.
- Before creating/updating tasks, read `references/task-taxonomy.md` for valid task statuses and task-type rules; use `references/task-taxonomy.json` for the current project-specific task-type ID snapshot instead of refetching repeatedly.
- For endpoint summaries and schema fields, read `references/api-reference.md`.
- For exact OpenAPI details, inspect `references/openapi.json`.

## Common starting points

- List projects: `GET /api/projects`
- List tasks/tickets/stories globally: `GET /api/tasks`
- List tasks in a project: `GET /api/projects/{project_id}/tasks`
- Get one task/ticket/story: `GET /api/tasks/{task_id}`
- Valid task statuses: `unopened`, `in_planning`, `in_execution`, `ready_for_human_review`, `human_reviewed_and_closed`
- Usual task type names: `Feature`, `Bug`, `Research`, `Debate`, `Work` (IDs are project-specific; consult `references/task-taxonomy.json`)
- Task comments: `GET /api/tasks/{task_id}/comments`
- Add a comment: `POST /api/comments`
- Search/list goals: `GET /api/goals/search`, `GET /api/goals/full`, `GET /api/goals`
- Health check: `GET /healthz`

Treat "ticket" and "story" as user-facing synonyms for Scryer tasks unless context shows they mean something else.
