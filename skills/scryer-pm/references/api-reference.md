# Scryer PM API Reference

Source: `PM System` OpenAPI 3.1.0, version 0.1.0.

Base URL default: `http://100.105.192.98:43210` (override with `SCRYER_API_BASE_URL` or `PI_PM_API_BASE_URL`).

Use this summary first. If exact validation rules are needed, inspect `references/openapi.json`.

## Endpoint groups

- [agents](#agents)
- [attachments](#attachments)
- [comments](#comments)
- [goal-checklist-items](#goal-checklist-items)
- [goal-relationships](#goal-relationships)
- [goals](#goals)
- [healthz](#healthz)
- [notes](#notes)
- [panic-stop](#panic-stop)
- [project-properties](#project-properties)
- [projects](#projects)
- [skill-defaults](#skill-defaults)
- [tags](#tags)
- [task-properties](#task-properties)
- [task-types](#task-types)
- [tasks](#tasks)

## agents

### `GET /api/agents`
List Agents  
Response: `AgentRead[]`  
Operation: `list_agents_api_agents_get`

### `POST /api/agents`
Create Agent  
Request: `AgentCreate` | Response: `AgentRead`  
Operation: `create_agent_api_agents_post`

### `GET /api/agents/{agent_id}`
Get Agent  
Response: `AgentRead` | Params: agent_id (path, required)  
Operation: `get_agent_api_agents__agent_id__get`

### `PATCH /api/agents/{agent_id}`
Update Agent  
Request: `AgentUpdate` | Response: `AgentRead` | Params: agent_id (path, required)  
Operation: `update_agent_api_agents__agent_id__patch`

### `DELETE /api/agents/{agent_id}`
Delete Agent  
Response: `SoftDeleteResponse` | Params: agent_id (path, required)  
Operation: `delete_agent_api_agents__agent_id__delete`

### `GET /api/agents/{agent_id}/models`
List Agent Models  
Response: `AgentModelRead[]` | Params: agent_id (path, required)  
Operation: `list_agent_models_api_agents__agent_id__models_get`

### `POST /api/agents/{agent_id}/models`
Create Agent Model  
Request: `AgentModelCreate` | Response: `AgentModelRead` | Params: agent_id (path, required)  
Operation: `create_agent_model_api_agents__agent_id__models_post`

### `PATCH /api/agents/models/{model_id}`
Update Agent Model  
Request: `AgentModelUpdate` | Response: `AgentModelRead` | Params: model_id (path, required)  
Operation: `update_agent_model_api_agents_models__model_id__patch`

### `DELETE /api/agents/models/{model_id}`
Delete Agent Model  
Response: `SoftDeleteResponse` | Params: model_id (path, required)  
Operation: `delete_agent_model_api_agents_models__model_id__delete`

## attachments

### `GET /api/attachments`
List Attachments  
Response: `AttachmentRead[]` | Params: entity_type (query, required), entity_id (query, required)  
Operation: `list_attachments_api_attachments_get`

### `POST /api/attachments`
Create Attachment  
Request: `Body_create_attachment_api_attachments_post` | Response: `AttachmentRead`  
Operation: `create_attachment_api_attachments_post`

### `GET /api/attachments/{attachment_id}`
Get Attachment  
Response: `AttachmentRead` | Params: attachment_id (path, required)  
Operation: `get_attachment_api_attachments__attachment_id__get`

### `DELETE /api/attachments/{attachment_id}`
Delete Attachment  
Response: `SoftDeleteResponse` | Params: attachment_id (path, required)  
Operation: `delete_attachment_api_attachments__attachment_id__delete`

### `GET /api/attachments/{attachment_id}/content`
Read Attachment  
Params: attachment_id (path, required), download (query)  
Operation: `read_attachment_api_attachments__attachment_id__content_get`

## comments

### `POST /api/comments`
Create Comment  
Request: `CommentCreate` | Response: `CommentRead`  
Operation: `create_comment_api_comments_post`

### `PATCH /api/comments/{comment_id}`
Update Comment  
Request: `CommentUpdate` | Response: `CommentRead` | Params: comment_id (path, required)  
Operation: `update_comment_api_comments__comment_id__patch`

### `DELETE /api/comments/{comment_id}`
Delete Comment  
Response: `SoftDeleteResponse` | Params: comment_id (path, required)  
Operation: `delete_comment_api_comments__comment_id__delete`

## goal-checklist-items

### `GET /api/goal-checklist-items/{item_id}`
Get Checklist Item  
Response: `GoalChecklistItemRead` | Params: item_id (path, required)  
Operation: `get_checklist_item_api_goal_checklist_items__item_id__get`

### `PATCH /api/goal-checklist-items/{item_id}`
Update Checklist Item  
Request: `GoalChecklistItemUpdate` | Response: `GoalChecklistItemRead` | Params: item_id (path, required)  
Operation: `update_checklist_item_api_goal_checklist_items__item_id__patch`

### `DELETE /api/goal-checklist-items/{item_id}`
Delete Checklist Item  
Request: `ActorPayload` | Response: `SoftDeleteResponse` | Params: item_id (path, required)  
Operation: `delete_checklist_item_api_goal_checklist_items__item_id__delete`

### `POST /api/goal-checklist-items/{item_id}/graduate`
Graduate Checklist Item  
Request: `GoalChecklistItemGraduate` | Response: `GoalFullRead` | Params: item_id (path, required)  
Operation: `graduate_checklist_item_api_goal_checklist_items__item_id__graduate_post`

### `GET /api/goal-checklist-items/{item_id}/comments`
List Checklist Item Comments  
Response: `CommentRead[]` | Params: item_id (path, required)  
Operation: `list_checklist_item_comments_api_goal_checklist_items__item_id__comments_get`

### `POST /api/goal-checklist-items/{item_id}/comments`
Create Checklist Item Comment  
Request: `CommentCreate` | Response: `CommentRead` | Params: item_id (path, required)  
Operation: `create_checklist_item_comment_api_goal_checklist_items__item_id__comments_post`

## goal-relationships

### `GET /api/goal-relationships`
List Relationships  
Response: `GoalRelationshipRead[]` | Params: goal_id (query)  
Operation: `list_relationships_api_goal_relationships_get`

### `POST /api/goal-relationships`
Create Relationship  
Request: `GoalRelationshipCreate` | Response: `GoalRelationshipRead`  
Operation: `create_relationship_api_goal_relationships_post`

### `PATCH /api/goal-relationships/{relationship_id}`
Update Relationship  
Request: `GoalRelationshipUpdate` | Response: `GoalRelationshipRead` | Params: relationship_id (path, required)  
Operation: `update_relationship_api_goal_relationships__relationship_id__patch`

### `DELETE /api/goal-relationships/{relationship_id}`
Delete Relationship  
Request: `ActorPayload` | Response: `SoftDeleteResponse` | Params: relationship_id (path, required)  
Operation: `delete_relationship_api_goal_relationships__relationship_id__delete`

## goals

### `GET /api/goals`
List Goals  
Response: `GoalRead[]` | Params: include_done (query), include_deleted (query), done (query), updated_since (query), created_since (query), q (query)  
Operation: `list_goals_api_goals_get`

### `POST /api/goals`
Create Goal  
Request: `GoalCreate` | Response: `GoalFullRead`  
Operation: `create_goal_api_goals_post`

### `GET /api/goals/full`
List Goals Full  
Response: `GoalFullRead[]` | Params: include_done (query), include_deleted (query), done (query), q (query), order_by (query), order_dir (query)  
Operation: `list_goals_full_api_goals_full_get`

### `GET /api/goals/search`
Search Goals  
Response: `GoalSearchResult[]` | Params: q (query, required), include_done (query), include_deleted (query), limit (query)  
Operation: `search_goals_api_goals_search_get`

### `GET /api/goals/activity`
List Goal Activity  
Response: `GoalActivityEventRead[]` | Params: since (query), until (query), event_type (query), goal_id (query), limit (query)  
Operation: `list_goal_activity_api_goals_activity_get`

### `GET /api/goals/updated`
List Updated Goals  
Response: `GoalFullRead[]` | Params: since (query), until (query)  
Operation: `list_updated_goals_api_goals_updated_get`

### `GET /api/goals/finished`
List Finished Goals  
Response: `GoalFullRead[]` | Params: since (query), until (query)  
Operation: `list_finished_goals_api_goals_finished_get`

### `GET /api/goals/{goal_id}`
Get Goal  
Response: `GoalFullRead` | Params: goal_id (path, required)  
Operation: `get_goal_api_goals__goal_id__get`

### `PATCH /api/goals/{goal_id}`
Update Goal  
Request: `GoalUpdate` | Response: `GoalFullRead` | Params: goal_id (path, required)  
Operation: `update_goal_api_goals__goal_id__patch`

### `DELETE /api/goals/{goal_id}`
Delete Goal  
Request: `ActorPayload` | Response: `SoftDeleteResponse` | Params: goal_id (path, required)  
Operation: `delete_goal_api_goals__goal_id__delete`

### `GET /api/goals/{goal_id}/activity`
List One Goal Activity  
Response: `GoalActivityEventRead[]` | Params: goal_id (path, required), since (query), until (query), event_type (query), limit (query)  
Operation: `list_one_goal_activity_api_goals__goal_id__activity_get`

### `GET /api/goals/{goal_id}/checklist-items`
List Checklist Items  
Response: `GoalChecklistItemRead[]` | Params: goal_id (path, required), include_deleted (query)  
Operation: `list_checklist_items_api_goals__goal_id__checklist_items_get`

### `POST /api/goals/{goal_id}/checklist-items`
Create Checklist Item  
Request: `GoalChecklistItemCreate` | Response: `GoalChecklistItemRead` | Params: goal_id (path, required)  
Operation: `create_checklist_item_api_goals__goal_id__checklist_items_post`

### `GET /api/goals/{goal_id}/relationships`
List Goal Relationships  
Response: `GoalRelationshipRead[]` | Params: goal_id (path, required)  
Operation: `list_goal_relationships_api_goals__goal_id__relationships_get`

## healthz

### `GET /healthz`
Healthcheck  
Operation: `healthcheck_healthz_get`

## notes

### `GET /api/notes`
List Notes  
Response: `NoteRead[]` | Params: entity_type (query, required), entity_id (query, required)  
Operation: `list_notes_api_notes_get`

### `POST /api/notes`
Create Note  
Request: `NoteCreate` | Response: `NoteRead`  
Operation: `create_note_api_notes_post`

### `GET /api/notes/{note_id}`
Get Note  
Response: `NoteDetail` | Params: note_id (path, required)  
Operation: `get_note_api_notes__note_id__get`

### `PATCH /api/notes/{note_id}`
Update Note  
Request: `NoteUpdate` | Response: `NoteRead` | Params: note_id (path, required)  
Operation: `update_note_api_notes__note_id__patch`

### `DELETE /api/notes/{note_id}`
Delete Note  
Response: `SoftDeleteResponse` | Params: note_id (path, required)  
Operation: `delete_note_api_notes__note_id__delete`

## panic-stop

### `POST /api/panic-stop`
Panic Stop  
Response: `PanicStopResponse`  
Operation: `panic_stop_api_panic_stop_post`

### `POST /api/panic-stop/{process_id}`
Stop Process  
Response: `PanicStopResponse` | Params: process_id (path, required)  
Operation: `stop_process_api_panic_stop__process_id__post`

## project-properties

### `GET /api/project-properties`
List Project Properties  
Response: `ProjectPropertyRead[]` | Params: project_id (query, required)  
Operation: `list_project_properties_api_project_properties_get`

### `POST /api/project-properties`
Create Project Property  
Request: `ProjectPropertyCreate` | Response: `ProjectPropertyRead`  
Operation: `create_project_property_api_project_properties_post`

### `PATCH /api/project-properties/{property_id}`
Update Project Property  
Request: `ProjectPropertyUpdate` | Response: `ProjectPropertyRead` | Params: property_id (path, required)  
Operation: `update_project_property_api_project_properties__property_id__patch`

### `DELETE /api/project-properties/{property_id}`
Delete Project Property  
Response: `SoftDeleteResponse` | Params: property_id (path, required)  
Operation: `delete_project_property_api_project_properties__property_id__delete`

## projects

### `GET /api/projects`
List Projects  
Response: `ProjectRead[]`  
Operation: `list_projects_api_projects_get`

### `POST /api/projects`
Create Project  
Request: `ProjectCreate` | Response: `ProjectRead`  
Operation: `create_project_api_projects_post`

### `GET /api/projects/deleted`
List Deleted Projects  
Response: `ProjectDeletedRead[]`  
Operation: `list_deleted_projects_api_projects_deleted_get`

### `GET /api/projects/{project_id}`
Get Project  
Response: `ProjectRead` | Params: project_id (path, required)  
Operation: `get_project_api_projects__project_id__get`

### `PATCH /api/projects/{project_id}`
Update Project  
Request: `ProjectUpdate` | Response: `ProjectRead` | Params: project_id (path, required)  
Operation: `update_project_api_projects__project_id__patch`

### `DELETE /api/projects/{project_id}`
Delete Project  
Response: `SoftDeleteResponse` | Params: project_id (path, required)  
Operation: `delete_project_api_projects__project_id__delete`

### `GET /api/projects/{project_id}/children`
List Project Children  
Response: `ProjectRead[]` | Params: project_id (path, required), depth (query)  
Operation: `list_project_children_api_projects__project_id__children_get`

### `GET /api/projects/{project_id}/subprojects`
List Subprojects  
Response: `ProjectRead[]` | Params: project_id (path, required), depth (query)  
Operation: `list_subprojects_api_projects__project_id__subprojects_get`

### `POST /api/projects/{project_id}/subprojects`
Create Subproject  
Request: `ProjectCreate` | Response: `ProjectRead` | Params: project_id (path, required)  
Operation: `create_subproject_api_projects__project_id__subprojects_post`

### `POST /api/projects/{project_id}/parent`
Attach Project To Parent  
Request: `ProjectAttach` | Response: `ProjectRead` | Params: project_id (path, required)  
Operation: `attach_project_to_parent_api_projects__project_id__parent_post`

### `GET /api/projects/{project_id}/comments`
List Project Comments  
Response: `CommentRead[]` | Params: project_id (path, required)  
Operation: `list_project_comments_api_projects__project_id__comments_get`

### `GET /api/projects/{project_id}/properties`
List Project Properties  
Response: `ProjectPropertyRead[]` | Params: project_id (path, required)  
Operation: `list_project_properties_api_projects__project_id__properties_get`

### `GET /api/projects/{project_id}/repo-link`
Get Project Repo Link  
Response: `Response Get Project Repo Link Api Projects  Project Id  Repo Link Get` | Params: project_id (path, required)  
Operation: `get_project_repo_link_api_projects__project_id__repo_link_get`

### `PUT /api/projects/{project_id}/repo-link`
Upsert Project Repo Link  
Request: `ProjectRepoLinkUpsert` | Response: `ProjectRepoLinkRead` | Params: project_id (path, required)  
Operation: `upsert_project_repo_link_api_projects__project_id__repo_link_put`

### `GET /api/projects/{project_id}/tasks`
List Project Tasks  
Response: `TaskRead[]` | Params: project_id (path, required)  
Operation: `list_project_tasks_api_projects__project_id__tasks_get`

### `POST /api/projects/{project_id}/tasks`
Create Project Task  
Request: `TaskCreate` | Response: `TaskRead` | Params: project_id (path, required)  
Operation: `create_project_task_api_projects__project_id__tasks_post`

### `GET /api/projects/{project_id}/tasks/deleted`
List Deleted Project Tasks  
Response: `TaskDeletedRead[]` | Params: project_id (path, required)  
Operation: `list_deleted_project_tasks_api_projects__project_id__tasks_deleted_get`

### `POST /api/projects/{project_id}/tasks/reorder`
Reorder Project Tasks  
Request: `TaskReorderRequest` | Response: `TaskRead[]` | Params: project_id (path, required)  
Operation: `reorder_project_tasks_api_projects__project_id__tasks_reorder_post`

## skill-defaults

### `GET /api/skill-defaults`
List Skill Defaults  
Response: `SkillDefaultRead[]`  
Operation: `list_skill_defaults_api_skill_defaults_get`

### `PUT /api/skill-defaults/{skill_name}`
Upsert Skill Default  
Request: `SkillDefaultUpdate` | Response: `SkillDefaultRead` | Params: skill_name (path, required)  
Operation: `upsert_skill_default_api_skill_defaults__skill_name__put`

## tags

### `GET /api/tags`
List Tags  
Response: `TagRead[]`  
Operation: `list_tags_api_tags_get`

### `POST /api/tags`
Create Tag  
Request: `TagCreate` | Response: `TagRead`  
Operation: `create_tag_api_tags_post`

### `POST /api/tags/tasks/{task_id}`
Add Tag To Task  
Request: `TagCreate` | Response: `TaskRead` | Params: task_id (path, required)  
Operation: `add_tag_to_task_api_tags_tasks__task_id__post`

### `DELETE /api/tags/tasks/{task_id}/{tag_name}`
Remove Tag From Task  
Response: `TaskRead` | Params: task_id (path, required), tag_name (path, required)  
Operation: `remove_tag_from_task_api_tags_tasks__task_id___tag_name__delete`

## task-properties

### `GET /api/task-properties`
List Task Properties  
Response: `TaskPropertyRead[]` | Params: task_id (query, required)  
Operation: `list_task_properties_api_task_properties_get`

### `POST /api/task-properties`
Create Task Property  
Request: `TaskPropertyCreate` | Response: `TaskPropertyRead`  
Operation: `create_task_property_api_task_properties_post`

### `PATCH /api/task-properties/{property_id}`
Update Task Property  
Request: `TaskPropertyUpdate` | Response: `TaskPropertyRead` | Params: property_id (path, required)  
Operation: `update_task_property_api_task_properties__property_id__patch`

### `DELETE /api/task-properties/{property_id}`
Delete Task Property  
Response: `SoftDeleteResponse` | Params: property_id (path, required)  
Operation: `delete_task_property_api_task_properties__property_id__delete`

## task-types

### `GET /api/task-types`
List Task Types  
Response: `TaskTypeRead[]` | Params: project_id (query, required)  
Operation: `list_task_types_api_task_types_get`

### `POST /api/task-types`
Create Task Type  
Request: `TaskTypeCreate` | Response: `TaskTypeRead`  
Operation: `create_task_type_api_task_types_post`

### `PATCH /api/task-types/{task_type_id}`
Update Task Type  
Request: `TaskTypeUpdate` | Response: `TaskTypeRead` | Params: task_type_id (path, required)  
Operation: `update_task_type_api_task_types__task_type_id__patch`

### `DELETE /api/task-types/{task_type_id}`
Delete Task Type  
Response: `SoftDeleteResponse` | Params: task_type_id (path, required)  
Operation: `delete_task_type_api_task_types__task_type_id__delete`

## tasks

### `GET /api/tasks`
List Tasks  
Response: `TaskRead[]` | Params: project_id (query), tag (query), status (query)  
Operation: `list_tasks_api_tasks_get`

### `POST /api/tasks`
Create Task  
Request: `TaskCreate` | Response: `TaskRead`  
Operation: `create_task_api_tasks_post`

### `GET /api/tasks/{task_id}`
Get Task  
Response: `TaskRead` | Params: task_id (path, required)  
Operation: `get_task_api_tasks__task_id__get`

### `PATCH /api/tasks/{task_id}`
Update Task  
Request: `TaskUpdate` | Response: `TaskRead` | Params: task_id (path, required)  
Operation: `update_task_api_tasks__task_id__patch`

### `DELETE /api/tasks/{task_id}`
Delete Task  
Response: `SoftDeleteResponse` | Params: task_id (path, required)  
Operation: `delete_task_api_tasks__task_id__delete`

### `GET /api/tasks/{task_id}/children`
List Task Children  
Response: `TaskRead[]` | Params: task_id (path, required), depth (query)  
Operation: `list_task_children_api_tasks__task_id__children_get`

### `POST /api/tasks/{task_id}/blockers`
Add Blocker  
Request: `DependencyCreate` | Response: `DependencyRead` | Params: task_id (path, required)  
Operation: `add_blocker_api_tasks__task_id__blockers_post`

### `GET /api/tasks/{task_id}/blockers`
List Blockers  
Response: `BlockerNode[]` | Params: task_id (path, required), depth (query)  
Operation: `list_blockers_api_tasks__task_id__blockers_get`

### `DELETE /api/tasks/{task_id}/blockers/{blocking_task_id}`
Remove Blocker  
Response: `SoftDeleteResponse` | Params: task_id (path, required), blocking_task_id (path, required)  
Operation: `remove_blocker_api_tasks__task_id__blockers__blocking_task_id__delete`

### `GET /api/tasks/{task_id}/comments`
List Task Comments  
Response: `CommentRead[]` | Params: task_id (path, required)  
Operation: `list_task_comments_api_tasks__task_id__comments_get`

### `GET /api/tasks/{task_id}/properties`
List Task Properties  
Response: `TaskPropertyRead[]` | Params: task_id (path, required)  
Operation: `list_task_properties_api_tasks__task_id__properties_get`

## Schemas

### `ActorPayload`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key

### `AgentCreate`
`key`*: Key, `name`*: Name, `is_enabled`: Is Enabled

### `AgentModelCreate`
`agent_id`: Agent Id, `model_id`*: Model Id, `label`: Label, `is_default`: Is Default

### `AgentModelRead`
`id`*: Id, `agent_id`*: Agent Id, `model_id`*: Model Id, `label`*: Label, `is_default`*: Is Default, `is_enabled`*: Is Enabled, `created_at`*: Created At, `updated_at`*: Updated At

### `AgentModelUpdate`
`model_id`: Model Id, `label`: Label, `is_default`: Is Default, `is_enabled`: Is Enabled

### `AgentRead`
`id`*: Id, `key`*: Key, `name`*: Name, `default_model_id`*: Default Model Id, `is_enabled`*: Is Enabled, `created_at`*: Created At, `updated_at`*: Updated At

### `AgentUpdate`
`name`: Name, `default_model_id`: Default Model Id, `is_enabled`: Is Enabled

### `AttachmentRead`
`id`*: Id, `entity_type`*: Entity Type, `entity_id`*: Entity Id, `file_name`*: File Name, `storage_path`*: Storage Path, `content_type`*: Content Type, `size_bytes`*: Size Bytes, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `created_at`*: Created At, `updated_at`*: Updated At

### `BlockerNode`
`depth`*: Depth, `task`*: TaskRead

### `Body_create_attachment_api_attachments_post`
`entity_type`*: Entity Type, `entity_id`*: Entity Id, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `file`*: File

### `CommentCreate`
`author_role`*: Author Role, `author_instance_key`*: Author Instance Key, `body_md`*: Body Md, `body_format`: Body Format, `project_id`: Project Id, `task_id`: Task Id, `goal_checklist_item_id`: Goal Checklist Item Id, `parent_comment_id`: Parent Comment Id

### `CommentRead`
`id`*: Id, `author_role`*: Author Role, `author_instance_key`*: Author Instance Key, `body_md`*: Body Md, `body_format`*: Body Format, `project_id`*: Project Id, `task_id`*: Task Id, `goal_checklist_item_id`*: Goal Checklist Item Id, `parent_comment_id`*: Parent Comment Id, `is_human_comment`*: Is Human Comment, `created_at`*: Created At, `updated_at`*: Updated At

### `CommentUpdate`
`body_md`*: Body Md

### `DependencyCreate`
`blocking_task_id`*: Blocking Task Id, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key

### `DependencyRead`
`id`*: Id, `blocked_task_id`*: Blocked Task Id, `blocking_task_id`*: Blocking Task Id, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `created_at`*: Created At

### `GoalActivityEventRead`
`id`*: Id, `goal_id`*: Goal Id, `checklist_item_id`*: Checklist Item Id, `event_type`*: Event Type, `occurred_at`*: Occurred At, `actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `summary`*: Summary, `data`: Data

### `GoalChecklistItemCreate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `title`*: Title, `description_md`: Description Md, `is_done`: Is Done, `completed_at`: Completed At, `display_order`: Display Order

### `GoalChecklistItemGraduate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `target`: Target, `relationship_type`: Relationship Type

### `GoalChecklistItemInitial`
`title`*: Title, `description_md`: Description Md, `is_done`: Is Done, `completed_at`: Completed At, `display_order`: Display Order

### `GoalChecklistItemRead`
`id`*: Id, `goal_id`*: Goal Id, `title`*: Title, `description_md`*: Description Md, `is_done`*: Is Done, `completed_at`*: Completed At, `display_order`*: Display Order, `created_at`*: Created At, `updated_at`*: Updated At

### `GoalChecklistItemUpdate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `title`: Title, `description_md`: Description Md, `is_done`: Is Done, `completed_at`: Completed At, `display_order`: Display Order

### `GoalCreate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `title`*: Title, `description_md`: Description Md, `is_done`: Is Done, `completed_at`: Completed At, `checklist_items`: GoalChecklistItemInitial[]

### `GoalFullRead`
`id`*: Id, `title`*: Title, `description_md`*: Description Md, `is_done`*: Is Done, `completed_at`*: Completed At, `created_at`*: Created At, `updated_at`*: Updated At, `last_updated_at`: Last Updated At, `last_worked_on_at`: Last Worked On At, `checklist_items`: GoalChecklistItemRead[]

### `GoalRead`
`id`*: Id, `title`*: Title, `description_md`*: Description Md, `is_done`*: Is Done, `completed_at`*: Completed At, `created_at`*: Created At, `updated_at`*: Updated At, `last_updated_at`: Last Updated At, `last_worked_on_at`: Last Worked On At

### `GoalRelationshipCreate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `source_goal_id`*: Source Goal Id, `target_goal_id`*: Target Goal Id, `relationship_type`: Relationship Type

### `GoalRelationshipRead`
`id`*: Id, `source_goal_id`*: Source Goal Id, `target_goal_id`*: Target Goal Id, `relationship_type`*: Relationship Type, `created_at`*: Created At, `updated_at`*: Updated At

### `GoalRelationshipUpdate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `relationship_type`: Relationship Type

### `GoalSearchMatch`
`match_type`*: Match Type, `field`*: Field, `checklist_item_id`: Checklist Item Id, `snippet`: Snippet

### `GoalSearchResult`
`goal`*: GoalFullRead, `matches`*: GoalSearchMatch[]

### `GoalUpdate`
`actor_role`*: Actor Role, `actor_instance_key`*: Actor Instance Key, `title`: Title, `description_md`: Description Md, `is_done`: Is Done, `completed_at`: Completed At

### `HTTPValidationError`
`detail`: ValidationError[]

### `NoteCreate`
`entity_type`*: Entity Type, `entity_id`*: Entity Id, `title`*: Title, `content_md`*: Content Md, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key

### `NoteDetail`
`id`*: Id, `entity_type`*: Entity Type, `entity_id`*: Entity Id, `title`*: Title, `storage_path`*: Storage Path, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `created_at`*: Created At, `updated_at`*: Updated At, `content_md`*: Content Md

### `NoteRead`
`id`*: Id, `entity_type`*: Entity Type, `entity_id`*: Entity Id, `title`*: Title, `storage_path`*: Storage Path, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `created_at`*: Created At, `updated_at`*: Updated At

### `NoteUpdate`
`title`: Title, `content_md`: Content Md

### `PanicStopResponse`
`process_count`*: Process Count, `paused_count`*: Paused Count, `task_reset_count`*: Task Reset Count, `tmux_killed_count`*: Tmux Killed Count, `pending_cleared_count`*: Pending Cleared Count, `errors`*: string[]

### `ProjectAttach`
`parent_project_id`*: Parent Project Id

### `ProjectCreate`
`name`*: Name, `slug`*: Slug, `description_md`: Description Md, `parent_project_id`: Parent Project Id, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key

### `ProjectDeletedRead`
`id`*: Id, `parent_project_id`*: Parent Project Id, `name`*: Name, `slug`*: Slug, `description_md`*: Description Md, `relative_repo_path`: Relative Repo Path, `remote_repo_url`: Remote Repo Url, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `created_at`*: Created At, `updated_at`*: Updated At, `deleted_at`*: Deleted At

### `ProjectPropertyCreate`
`project_id`*: Project Id, `key`*: Key, `value`*: Value, `value_type`: Value Type

### `ProjectPropertyRead`
`id`*: Id, `project_id`*: Project Id, `key`*: Key, `value`*: Value, `value_type`*: Value Type, `created_at`*: Created At, `updated_at`*: Updated At

### `ProjectPropertyUpdate`
`value`: Value, `value_type`: Value Type

### `ProjectRead`
`id`*: Id, `parent_project_id`*: Parent Project Id, `name`*: Name, `slug`*: Slug, `description_md`*: Description Md, `relative_repo_path`: Relative Repo Path, `remote_repo_url`: Remote Repo Url, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `created_at`*: Created At, `updated_at`*: Updated At

### `ProjectRepoLinkRead`
`id`*: Id, `project_id`*: Project Id, `remote_url`*: Remote Url, `repo_subpath`*: Repo Subpath, `relative_repo_path`*: Relative Repo Path, `absolute_repo_path`*: Absolute Repo Path, `clone_status`*: Clone Status, `clone_progress`*: Clone Progress, `clone_stage`*: Clone Stage, `error_message`*: Error Message, `created_at`*: Created At, `updated_at`*: Updated At

### `ProjectRepoLinkUpsert`
`remote_url`*: Remote Url

### `ProjectUpdate`
`name`: Name, `slug`: Slug, `description_md`: Description Md, `parent_project_id`: Parent Project Id

### `SkillDefaultRead`
`skill_name`*: Skill Name, `default_agent_key`*: Default Agent Key, `default_model_id`*: Default Model Id, `created_at`*: Created At, `updated_at`*: Updated At

### `SkillDefaultUpdate`
`default_agent_key`: Default Agent Key, `default_model_id`: Default Model Id

### `SoftDeleteResponse`
`id`*: Id, `deleted_at`*: Deleted At

### `TagCreate`
`name`*: Name

### `TagRead`
`id`*: Id, `name`*: Name, `created_at`*: Created At, `updated_at`*: Updated At

### `TaskCreate`
`title`*: Title, `task_type_id`*: Task Type Id, `status`*: Status, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `project_id`: Project Id, `parent_task_id`: Parent Task Id, `description_md`: Description Md, `tag_names`: string[]

### `TaskDeletedRead`
`id`*: Id, `project_id`*: Project Id, `parent_task_id`*: Parent Task Id, `task_type_id`*: Task Type Id, `display_order`*: Display Order, `title`*: Title, `description_md`*: Description Md, `status`*: Status, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `tags`*: TagRead[], `created_at`*: Created At, `updated_at`*: Updated At, `deleted_at`*: Deleted At

### `TaskPropertyCreate`
`task_id`*: Task Id, `key`*: Key, `value`*: Value, `value_type`: Value Type

### `TaskPropertyRead`
`id`*: Id, `task_id`*: Task Id, `key`*: Key, `value`*: Value, `value_type`*: Value Type, `created_at`*: Created At, `updated_at`*: Updated At

### `TaskPropertyUpdate`
`value`: Value, `value_type`: Value Type

### `TaskRead`
`id`*: Id, `project_id`*: Project Id, `parent_task_id`*: Parent Task Id, `task_type_id`*: Task Type Id, `display_order`*: Display Order, `title`*: Title, `description_md`*: Description Md, `status`*: Status, `created_by_role`*: Created By Role, `created_by_instance_key`*: Created By Instance Key, `tags`*: TagRead[], `created_at`*: Created At, `updated_at`*: Updated At

### `TaskReorderRequest`
`task_ids`*: string[]

### `TaskTypeCreate`
`project_id`*: Project Id, `key`*: Key, `name`*: Name, `color`: Color, `icon`: Icon, `behavior`*: Behavior, `is_default`: Is Default

### `TaskTypeRead`
`id`*: Id, `project_id`*: Project Id, `key`*: Key, `name`*: Name, `color`*: Color, `icon`*: Icon, `behavior_json`*: Behavior Json, `is_default`*: Is Default, `created_at`*: Created At, `updated_at`*: Updated At

### `TaskTypeUpdate`
`name`: Name, `color`: Color, `icon`: Icon, `behavior`: Behavior, `is_default`: Is Default

### `TaskUpdate`
`title`: Title, `status`: Status, `description_md`: Description Md, `project_id`: Project Id, `parent_task_id`: Parent Task Id, `task_type_id`: Task Type Id, `tag_names`: Tag Names

### `ValidationError`
`loc`*: object[], `msg`*: Message, `type`*: Error Type, `input`: Input, `ctx`: Context
