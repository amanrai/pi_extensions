# Scryer PM workflows

## Project lookup cache

Before calling `GET /api/projects` to resolve a project name, read the local cache written by the Pi footer extension:

```text
~/.pi/agent/scryer/projects.json
```

Use `projects[].name` and `projects[].id` from that file for normal project-name resolution. Re-read the file each time project-name resolution matters; do not hold a stale in-conversation copy across multiple Scryer operations. Only fall back to `GET /api/projects` when the freshly re-read cache file is missing/unreadable or the requested project is absent from the cache, which usually means it is newly created or the extension is not active.

The goal is not to avoid the API completely; it is to minimize unnecessary broad lookups. Hit the API when needed for freshness, full record details, comments, writes, or to refresh a missing/stale cache. Prefer narrow/project-scoped API calls over global searches.

## Task ID cache

Per-project task/ticket/story indexes live at:

```text
~/.pi/agent/scryer/projects/<project_id>.json
```

Use these files for task ID resolution. If the file is missing or older than 10 minutes, refresh it with `GET /api/projects/{project_id}/tasks`, write the JSON, then search the JSON. If a task is still not found, refresh that project index once more and search the JSON again; this covers newly-created tickets. Avoid global `GET /api/tasks` for ID lookup unless there is no project context and the user cannot provide one.

## Identify records safely

1. Determine the entity type from the user's wording:
   - ticket/story/task/work item → Scryer task
   - project → Scryer project
   - goal/objective → Scryer goal
   - checklist item/subtask on a goal → goal checklist item
   - note/attachment/comment/tag/blocker → corresponding resource
2. If the user gives a project name, resolve it from `~/.pi/agent/scryer/projects.json` first.
3. For task/ticket/story title lookup inside a project, resolve the task ID from `~/.pi/agent/scryer/projects/<project_id>.json`; refresh that project cache if missing/stale or not found.
4. If the user gives a task ID explicitly, you may fetch that record directly.
5. If multiple candidates match, show concise candidates with IDs and ask the user to choose.
6. Before writes, fetch the current record so your change is grounded in the latest state.

## Look at a ticket/story/task

Use when the user says "look at the ticket", "what does the story say", "find the ticket", etc.

1. If ID is known: `GET /api/tasks/{task_id}`.
2. Otherwise resolve the project first, then resolve the task ID from `~/.pi/agent/scryer/projects/<project_id>.json`.
3. If the per-project JSON is missing, older than 10 minutes, or does not contain the ticket/story/task, refresh it with `GET /api/projects/{project_id}/tasks`, write the JSON, and search the JSON again.
4. Fetch related context as useful:
   - comments: `GET /api/tasks/{task_id}/comments`
   - blockers: `GET /api/tasks/{task_id}/blockers`
   - children: `GET /api/tasks/{task_id}/children`
   - properties: `GET /api/tasks/{task_id}/properties`
5. Summarize title, status, project, type, description, tags, blockers, and latest comments.

## Update a ticket/story/task

1. Resolve the task ID from the per-project JSON cache when the user gives a title/name. If the cache is missing/stale/not found, refresh the project task index once and search the JSON again. If the user gives an explicit task ID, use it directly.
2. Fetch the authoritative task record with `GET /api/tasks/{task_id}`.
3. Decide whether this should be a comment or a field change:
   - Progress notes, decisions, findings, and handoff info → `POST /api/comments` with `task_id`.
   - Canonical changes to title/status/description/project/parent/type/tags → `PATCH /api/tasks/{task_id}`.
4. Use minimal PATCH bodies. Do not rewrite descriptions unless the user asks.
5. Confirm if the update is destructive, large, or ambiguous.
6. Report the changed fields and the task ID.

## Create a ticket/story/task

1. Identify the project first. Re-read `~/.pi/agent/scryer/projects.json`; use `GET /api/projects` only if the cache is unavailable or the project is not found. If ambiguous, ask.
2. Choose status from `references/task-taxonomy.md`; usually `unopened` for newly captured work.
3. Choose task type from `references/task-taxonomy.md`. Task type IDs are project-specific; use the snapshot in `references/task-taxonomy.json` or fetch that project's task types once.
4. Create with `POST /api/projects/{project_id}/tasks` or `POST /api/tasks`.
5. Include:
   - `title`
   - `task_type_id`
   - `status`
   - `project_id` when using global create
   - `description_md` if supplied or useful
   - `created_by_role`: `pi-agent`
   - `created_by_instance_key`: `pi` unless a better local instance key is available
   - `tag_names` if the user requested tags
6. Return title, status, type, project, and ID.

## Manage blockers/dependencies

- List blockers for a task: `GET /api/tasks/{task_id}/blockers`.
- Add a blocker: `POST /api/tasks/{task_id}/blockers` with `blocking_task_id`.
- Remove a blocker: `DELETE /api/tasks/{task_id}/blockers/{blocking_task_id}`.

Confirm before adding/removing blockers if the direction is unclear. "A blocks B" means A is the blocking task and B is the blocked task.

## Project workflows

- Resolve/list projects from cache first: re-read `~/.pi/agent/scryer/projects.json`.
- Fall back to API list only when needed: `GET /api/projects`.
- Get project: `GET /api/projects/{project_id}`.
- Children/subprojects: `GET /api/projects/{project_id}/children` or `/subprojects`.
- Project tasks: `GET /api/projects/{project_id}/tasks`.
- Project comments/properties: `/comments`, `/properties`.
- Repo link: `GET` or `PUT /api/projects/{project_id}/repo-link`.

Confirm before deleting projects or changing parent relationships.

## Comments

Use comments as the default way to preserve history.

Create a comment:

```json
{
  "author_role": "pi-agent",
  "author_instance_key": "pi",
  "body_md": "Markdown body",
  "task_id": "..."
}
```

Exactly one parent entity should usually be set: `project_id`, `task_id`, or `goal_checklist_item_id`. Use `parent_comment_id` for replies.

## Goals and checklist items

- List goals: `GET /api/goals`.
- Full goals with checklist items: `GET /api/goals/full`.
- Search goals: `GET /api/goals/search`.
- Activity: `GET /api/goals/activity` or `/api/goals/{goal_id}/activity`.
- Checklist items: `GET/POST /api/goals/{goal_id}/checklist-items`.
- Update checklist item: `PATCH /api/goal-checklist-items/{item_id}`.
- Graduate checklist item: `POST /api/goal-checklist-items/{item_id}/graduate`.
- Checklist item comments: `GET/POST /api/goal-checklist-items/{item_id}/comments`.

Use `is_done` and `completed_at` together when marking goal/checklist completion if the API accepts it. Confirm before marking a goal done unless the user is explicit.

## Notes and attachments

Notes attach durable content to an entity:

- List/create notes: `GET/POST /api/notes`
- Read/update/delete a note: `GET/PATCH/DELETE /api/notes/{note_id}`

Attachments are uploaded via multipart form:

- List/create attachments: `GET/POST /api/attachments`
- Metadata/delete: `GET/DELETE /api/attachments/{attachment_id}`
- Content: `GET /api/attachments/{attachment_id}/content`

Confirm before deleting notes or attachments.

## Tags and properties

- Tags: `GET/POST /api/tags`
- Add tag to task: `POST /api/tags/tasks/{task_id}`
- Remove tag from task: `DELETE /api/tags/tasks/{task_id}/{tag_name}`
- Project properties: `/api/project-properties`, `/api/projects/{project_id}/properties`
- Task properties: `/api/task-properties`, `/api/tasks/{task_id}/properties`

Use tags for searchable lightweight categorization; use properties for key/value metadata.

## Destructive and operational endpoints

- Most deletes are soft deletes, but still require confirmation.
- `POST /api/panic-stop` and `POST /api/panic-stop/{process_id}` are operational stop controls. Use only if the user explicitly asks to stop Scryer/agent processes or there is a clear safety need.
