# Scryer task taxonomy

Use this file before creating or updating Scryer tasks/tickets/stories. Do not refetch task types repeatedly; this snapshot captures the current valid task-status values and the current task-type naming pattern. If an API call rejects a type ID or the user is working in a newly-created project, refresh only that project's task types with `GET /api/task-types?project_id=...`.

## Valid task statuses

Use one of these exact `Task.status` strings:

- `unopened` — captured but not yet triaged/planned
- `in_planning` — being scoped or decomposed
- `in_execution` — actively being worked
- `ready_for_human_review` — implementation/work is ready for Aman/human review
- `human_reviewed_and_closed` — reviewed and closed/done

When unsure, prefer `unopened` for newly captured tickets/stories/tasks, or ask the user.

## Valid task type names

Most projects have the same five task-type names:

- `Feature`
- `Bug`
- `Research`
- `Debate`
- `Work`

A few projects currently have additional/custom task-type names:

- `Task` — currently seen in `~LoomTesting`
- `Ticket` — currently seen in `Samwell Tarly`

Important: task type **IDs are project-specific** even when the name is the same. Do not reuse a `Feature` ID from one project in another project. For creation, first identify the project, then select the matching task type for that project.

## Choosing a task type

- User says ticket/story/work item, or gives no type: use `Work` if available; if not, use the project default that best matches the user's language.
- New capability, UX, integration, or enhancement: `Feature`.
- Defect, broken behavior, regression: `Bug`.
- Investigation, exploration, unknown feasibility: `Research`.
- Decision, tradeoff, architecture argument, question requiring resolution: `Debate`.
- General execution item, chore, follow-up, story/ticket without a more specific type: `Work`.
- If a project has a literal `Ticket` type and the user specifically says ticket, use `Ticket` for that project.

## Current task-type snapshot

The machine-readable snapshot is in `task-taxonomy.json`. It maps each project to its current `task_types` records, including IDs. Use it when you need to avoid fetching task types again.

If the snapshot seems stale:

```bash
python skills/scryer-pm/scripts/scryer_api.py GET '/api/task-types?project_id=<project_id>'
```

Then use the returned ID for that project only.
