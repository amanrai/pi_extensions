---
name: scryer-pm
description: "Use ONLY on explicit user demand to read or modify Scryer/PM-system records: projects, tickets, stories, tasks, goals, checklist items, comments, blockers, notes, attachments, tags, or repo links. Trigger on phrases like 'look at the ticket', 'update the story', 'find the ticket', 'tell me what the ticket says', 'record this in Scryer/the PM system', or explicit mentions of Scryer/PM system. Do not use for general planning, ordinary code tasks, or casual mentions of projects/tasks/goals."
---

# Scryer PM

Scryer is Aman's API-first project-management system. Treat "ticket", "story", "task", and "work item" as user-facing synonyms for Scryer tasks unless context says otherwise.

## Activation rule

Use this skill only on explicit user demand to interact with Scryer/PM records.

Use it for phrases like:

- "Scryer", "PM system", "project management system"
- "look at the ticket", "find the ticket", "what does the ticket say?"
- "update the ticket/story/task", "add a comment to the ticket"
- "record this", "track this", "create a ticket/story/task" in a PM-record context
- explicit Scryer project/task/goal/checklist/comment IDs

Do not use it for general project-management advice, ordinary code work, local TODOs, or casual mentions of "project/task/goal/story/ticket" without PM-record intent. If ambiguous, ask whether the user means Scryer before calling the API.

## Default behavior: be narrow

For ordinary ticket lookup, do not read extra reference files. This `SKILL.md` contains the default workflow.

Default ticket lookup should fetch only:

1. project ID from local project cache
2. task ID from per-project task-name cache
3. authoritative task details from API
4. task comments from API

Do not fetch blockers, children/subtasks, properties, repo files, git status, source files, or handoff files by default.

After fetching the Scryer ticket and comments, explain what the ticket says and then offer local follow-up, for example:

> I found the Scryer ticket **"..."**. It says [...brief description/status/comments...]. I have not looked at the local repo, git state, source files, or handoff files yet. Want me to inspect the codebase or handoffs for implementation context?

## Cache rules

### CWD touched-ticket index

Scryer maintains a local index of tickets touched from each working directory:

```text
~/.pi/agent/scryer/cwd-ticket-index.json
```

Each record is flat:

```json
{
  "cwd": "/exact/pi/cwd",
  "project_id": "...",
  "project_name": "...",
  "ticket_id": "...",
  "task_name": "...",
  "touched_at": "..."
}
```

A read is a touch. Any successful ticket interaction should record a touch: task detail reads, comments, updates, creates, deletes, blockers, tags, or any task-ID-related Scryer operation. The timestamp is only for pruning/archive; do not use it for ranking relevance.

For cwd `/Users/amanrai/a/b/c`, lookup touched tickets for all exact cwd prefixes up to `$HOME`: `/Users/amanrai/a/b/c`, `/Users/amanrai/a/b`, `/Users/amanrai/a`, `/Users/amanrai`. Gather all records and dedupe by `ticket_id`; order does not matter.

When a user asks for "the ticket" or gives a partial ticket name, check this cwd index first. If exactly one relevant ticket is found, use its `ticket_id` and go directly to `GET /api/tasks/{task_id}`. If multiple candidates match, show candidates and ask which one. Fall back to project/task caches only when cwd index has no clear match.

Records older than 30 days are pruned from the active index and moved to `~/.pi/agent/scryer/cwd-ticket-archive.json`. The archive is write-only history; do not read it for lookup.

### Project cache

The footer extension refreshes project names/IDs every 30 seconds and writes:

```text
~/.pi/agent/scryer/projects.json
```

Re-read this file each time project-name resolution matters. Do not rely on a project list loaded earlier in the conversation. Only call `GET /api/projects` if the freshly re-read cache is missing/unreadable or the requested project is absent.

### Per-project task ID cache

Per-project task-name indexes live at:

```text
~/.pi/agent/scryer/projects/<project_id>.json
```

This cache is only for ticket/story/task name → ID lookup. It should contain only task IDs and task titles/names, not task status, tags, descriptions, timestamps, or other details.

Full task details always come from the API after ID resolution:

```http
GET /api/tasks/{task_id}
```

If the per-project task cache is missing or older than 10 minutes, refresh it with:

```http
GET /api/projects/{project_id}/tasks
```

Then write the minimal JSON and read/search the JSON for the ID. If the ticket is not in the JSON, refresh that project task cache once from the API, write it, and search the JSON again. Report that a ticket does not exist only after checking both the existing cache and a refreshed API-backed cache.

The goal is to minimize unnecessary broad API calls, not to avoid the API entirely. Use narrow API calls when needed for cache refresh, authoritative details, comments, or writes. Avoid global `GET /api/tasks` for ID lookup when project context exists.

## Helper commands

Resolve relative paths from the skill directory. In an installed package this is usually:

```text
~/.pi/agent/git/github.com/amanrai/pi_extensions/skills/scryer-pm
```

Use the API helper for authoritative reads/writes:

```bash
python scripts/scryer_api.py GET /api/tasks/<task_id>
python scripts/scryer_api.py GET /api/tasks/<task_id>/comments
python scripts/scryer_api.py POST /api/comments --json '{"author_role":"pi-agent","author_instance_key":"pi","body_md":"...","task_id":"..."}'
python scripts/scryer_api.py PATCH /api/tasks/<task_id> --json '{"status":"in_execution"}'
```

Use the cache helper to resolve projects, refresh/ensure the per-project task ID cache, and inspect/touch cwd ticket lookup records:

```bash
python scripts/scryer_cache.py lookup-cwd-tickets --query "manifold"
python scripts/scryer_cache.py touch-ticket --project-id <project_id> --project-name "Chess" --ticket-id <task_id> --task-name "Manifold separator"
python scripts/scryer_cache.py find-project "Chess"
python scripts/scryer_cache.py ensure-project-tasks <project_id> --project-name "Chess"
```

Do not use a separate task-finding helper as the workflow. Read/search `~/.pi/agent/scryer/projects/<project_id>.json` directly for `{ "id", "title" }`, then call the API for full details.

## Look at a ticket/story/task

1. Check `~/.pi/agent/scryer/cwd-ticket-index.json` first for current cwd and all ancestors up to `$HOME`; dedupe by `ticket_id`.
2. If the cwd index gives one clear match, use that `ticket_id` and skip `projects.json`, per-project task cache lookup, and project/task list API calls.
3. If multiple cwd-index candidates match, ask the user which one.
4. If cwd index has no clear match, re-read `~/.pi/agent/scryer/projects.json` and resolve the project ID.
5. Read `~/.pi/agent/scryer/projects/<project_id>.json`.
6. If that file is missing or older than 10 minutes, run `python scripts/scryer_cache.py ensure-project-tasks <project_id> --project-name "<name>"`.
7. Search the per-project JSON directly for the ticket/story/task title and read its ID.
8. If not found, refresh the project task cache once, re-read the JSON, and search again.
9. If still not found, report that it was not found and mention that both cache and refreshed API-backed cache were checked.
10. Fetch authoritative task details: `GET /api/tasks/{task_id}`. This records a cwd touch when using `scripts/scryer_api.py`.
11. Fetch task comments: `GET /api/tasks/{task_id}/comments`.
12. Summarize only the Scryer ticket/comments.
13. Offer to inspect repo/source/git/handoff context, but do not do it yet.

If the user gives an explicit task ID, you may skip cache ID resolution and fetch `GET /api/tasks/{task_id}` directly.

## Update or comment on a ticket/story/task

1. Resolve the task ID using the lookup flow above, unless the user gave an explicit ID.
2. Fetch authoritative current details: `GET /api/tasks/{task_id}`. Ensure this ticket is recorded in the cwd touched-ticket index.
3. Decide whether this is a comment or field update:
   - Progress notes, findings, handoff notes, status commentary → `POST /api/comments`.
   - Canonical field changes such as title, description, status, parent, tags, or type → `PATCH /api/tasks/{task_id}`.
4. Use minimal PATCH bodies containing only fields to change.
5. Prefer comments for preserving history.
6. Confirm before destructive, broad, or ambiguous changes.

## Create a ticket/story/task

1. Resolve the project ID from `~/.pi/agent/scryer/projects.json`; fall back to `GET /api/projects` only if missing/not found.
2. Choose a valid status: `unopened`, `in_planning`, `in_execution`, `ready_for_human_review`, or `human_reviewed_and_closed`. When unsure for a new ticket, use `unopened`.
3. Choose a task type name:
   - `Feature` for new capabilities/enhancements
   - `Bug` for defects/regressions
   - `Research` for investigation/feasibility
   - `Debate` for decisions/tradeoffs/questions
   - `Work` for general tickets/stories/tasks
4. Task type IDs are project-specific. Use `references/task-taxonomy.json` for the current project-specific task-type ID snapshot; fetch that project's task types only if missing/stale/rejected.
5. Create via `POST /api/projects/{project_id}/tasks` or `POST /api/tasks`.
6. After creation, record the new ticket immediately in the cwd touched-ticket index and refresh the per-project task ID cache so newly-created tickets can be found by name later.

## Optional data: only when asked or clearly needed

- Blockers: call `GET /api/tasks/{task_id}/blockers` only when the user asks about blockers/dependencies or blocker context is clearly implied.
- Children/subtasks: call `GET /api/tasks/{task_id}/children` only when the user asks about children/subtasks/breakdown or that context is clearly implied.
- Properties: call `GET /api/tasks/{task_id}/properties` only when explicitly asked for properties, metadata, custom fields, or key/value data. Do not infer this.
- Repo/source/git inspection: do not run `rg`, `find`, `git status`, or read source files unless the user explicitly asks for codebase/repo/implementation context or accepts your offer.
- Handoff files: never read handoff files automatically. Only read them when explicitly asked. Handoff files may be stale or irrelevant even if they look like the "latest" handoff in the repo.

## Safety rules

- Never guess IDs. Ask when matches are ambiguous.
- Confirm before `DELETE`, bulk edits, parent/project moves, deleting comments/notes/attachments, or other destructive operations.
- Do not silently overwrite descriptions or comments.
- Summarize API results in human terms and include IDs when useful for follow-up.

## References for uncommon work

Only read these when the user asks for deeper/uncommon operations:

- `references/task-taxonomy.md` / `task-taxonomy.json` — task statuses and project-specific task type IDs
- `references/api-reference.md` — human-readable endpoint/schema summary
- `references/openapi.json` — exact OpenAPI snapshot
- `references/workflows.md` — extended workflows for goals, attachments, notes, tags, properties, blockers, and operational endpoints
