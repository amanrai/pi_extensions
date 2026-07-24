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

## Project ID cache

The Pi footer extension refreshes Scryer project names/IDs every 30 seconds and writes them to:

```text
~/.pi/agent/scryer/projects.json
```

When resolving a project name to an ID, read this file first. Re-read it each time you need project-name resolution or before a meaningful Scryer operation; do not assume a project list you loaded earlier in the conversation is still current. It contains:

```json
{
  "base_url": "http://100.105.192.98:43210",
  "updated_at": "...",
  "refresh_interval_ms": 30000,
  "projects": [{ "id": "...", "name": "..." }]
}
```

Only call `GET /api/projects` if the freshly re-read cache file is missing/unreadable or the requested project is not present in the cached list, which usually means it was created less than one refresh interval ago or the footer extension is not active.

Per-project task/ticket/story indexes live at:

```text
~/.pi/agent/scryer/projects/<project_id>.json
```

For task/ticket/story ID resolution, use this per-project JSON file. If it does not exist or is older than 10 minutes, refresh it with `GET /api/projects/{project_id}/tasks` and write the JSON first. Then resolve the task ID by reading the JSON. If the task is not present in the JSON, refresh that project task index once from the API, write the updated JSON, and search the JSON again. This handles newly created tickets that are not in the local cache yet.

Do not resolve task IDs by calling global task search/list endpoints when project context is available. The API call is only for refreshing the project's JSON index; the ID you use for updates should be read from the JSON after refresh. The goal is to minimize unnecessary broad API calls, not to avoid the API entirely: use narrow API calls when needed for cache refresh, authoritative task details, comments, or writes.

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

Use the cache helper for project and task/ticket/story ID resolution:

```bash
python skills/scryer-pm/scripts/scryer_cache.py find-project "PMSystem"
python skills/scryer-pm/scripts/scryer_cache.py ensure-project-tasks <project_id>
python skills/scryer-pm/scripts/scryer_cache.py find-task <project_id> "ticket title"
```

Resolve relative paths from the skill directory. If this skill is installed globally, use the actual skill directory path after loading `SKILL.md`.

## What to read next

- For common workflows and decision rules, read `references/workflows.md`.
- Before creating/updating tasks, read `references/task-taxonomy.md` for valid task statuses and task-type rules; use `references/task-taxonomy.json` for the current project-specific task-type ID snapshot instead of refetching repeatedly.
- For endpoint summaries and schema fields, read `references/api-reference.md`.
- For exact OpenAPI details, inspect `references/openapi.json`.

## Common starting points

- Resolve project names/IDs: re-read `~/.pi/agent/scryer/projects.json` first each time; only fall back to `GET /api/projects` if missing or not found
- List projects: `GET /api/projects`
- Avoid global task ID lookup; prefer per-project task JSON caches
- Refresh a project's task ID cache: `GET /api/projects/{project_id}/tasks`, written to `~/.pi/agent/scryer/projects/<project_id>.json`
- Resolve task/ticket/story IDs from that per-project JSON cache; refresh first if missing or older than 10 minutes; if not found, refresh once and search the JSON again
- Get one task/ticket/story after resolving ID from JSON: `GET /api/tasks/{task_id}`
- Valid task statuses: `unopened`, `in_planning`, `in_execution`, `ready_for_human_review`, `human_reviewed_and_closed`
- Usual task type names: `Feature`, `Bug`, `Research`, `Debate`, `Work` (IDs are project-specific; consult `references/task-taxonomy.json`)
- Task comments: `GET /api/tasks/{task_id}/comments`
- Add a comment: `POST /api/comments`
- Search/list goals: `GET /api/goals/search`, `GET /api/goals/full`, `GET /api/goals`
- Health check: `GET /healthz`

Treat "ticket" and "story" as user-facing synonyms for Scryer tasks unless context shows they mean something else.
