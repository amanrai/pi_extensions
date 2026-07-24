# Scryer PM extended workflows

`SKILL.md` contains the default ticket lookup/update/create workflow. Read this file only for less-common Scryer operations or endpoint reminders.

## Cache principles

- Project IDs: re-read `~/.pi/agent/scryer/projects.json` whenever project-name resolution matters.
- Task IDs: use `~/.pi/agent/scryer/projects/<project_id>.json` as a minimal `{ id, title }` index.
- Full task details always come from `GET /api/tasks/{task_id}`.
- If a per-project task index is missing/stale or does not contain the requested ticket, refresh it with `GET /api/projects/{project_id}/tasks`, write the minimal JSON, then search the JSON again.
- Report "not found" only after checking both the existing cache and a refreshed API-backed cache.
- Minimize unnecessary broad API calls; prefer narrow project-scoped refreshes.

## Optional task context

Do not fetch these by default during ordinary ticket lookup:

- Blockers: `GET /api/tasks/{task_id}/blockers` only when blockers/dependencies are requested or clearly implied.
- Children/subtasks: `GET /api/tasks/{task_id}/children` only when subtasks/breakdown/child work is requested or clearly implied.
- Properties: `GET /api/tasks/{task_id}/properties` only when explicitly asked for properties, metadata, custom fields, or key/value data.

## Local repo and handoff context

Do not inspect local files by default after reading a Scryer ticket.

- Do not run `rg`, `find`, `git status`, or read source files unless the user asks for repo/codebase/implementation context or accepts your offer.
- Never read handoff files automatically. Handoff files may be stale or irrelevant even if they appear to be the "latest" handoff in the repo. Read them only when explicitly asked.

## Comments

Use comments as the default way to preserve history.

Create a task comment with `POST /api/comments`:

```json
{
  "author_role": "pi-agent",
  "author_instance_key": "pi",
  "body_md": "Markdown body",
  "task_id": "..."
}
```

Exactly one parent entity should usually be set: `project_id`, `task_id`, or `goal_checklist_item_id`. Use `parent_comment_id` for replies.

## Manage blockers/dependencies

- List blockers for a task: `GET /api/tasks/{task_id}/blockers`.
- Add a blocker: `POST /api/tasks/{task_id}/blockers` with `blocking_task_id`.
- Remove a blocker: `DELETE /api/tasks/{task_id}/blockers/{blocking_task_id}`.

Confirm direction before adding/removing blockers if unclear. "A blocks B" means A is the blocking task and B is the blocked task.

## Project workflows

- Resolve/list projects from cache first: re-read `~/.pi/agent/scryer/projects.json`.
- Fall back to API project list only when needed: `GET /api/projects`.
- Get project details: `GET /api/projects/{project_id}`.
- Children/subprojects: `GET /api/projects/{project_id}/children` or `/subprojects`.
- Project tasks/cache refresh: `GET /api/projects/{project_id}/tasks`.
- Project comments/properties: `/comments`, `/properties`.
- Repo link: `GET` or `PUT /api/projects/{project_id}/repo-link`.

Confirm before deleting projects or changing parent relationships.

## Goals and checklist items

- List goals: `GET /api/goals`.
- Full goals with checklist items: `GET /api/goals/full`.
- Search goals: `GET /api/goals/search`.
- Activity: `GET /api/goals/activity` or `/api/goals/{goal_id}/activity`.
- Checklist items: `GET/POST /api/goals/{goal_id}/checklist-items`.
- Update checklist item: `PATCH /api/goal-checklist-items/{item_id}`.
- Graduate checklist item: `POST /api/goal-checklist-items/{item_id}/graduate`.
- Checklist item comments: `GET/POST /api/goal-checklist-items/{item_id}/comments`.

Confirm before marking a goal done unless the user is explicit.

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

Use tags for searchable lightweight categorization; use properties for key/value metadata only when explicitly relevant.

## Destructive and operational endpoints

- Most deletes are soft deletes, but still require confirmation.
- `POST /api/panic-stop` and `POST /api/panic-stop/{process_id}` are operational stop controls. Use only if the user explicitly asks to stop Scryer/agent processes or there is a clear safety need.
