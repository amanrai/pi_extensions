#!/usr/bin/env python3
"""Scryer local cache helper.

Project names/IDs are maintained by the Pi footer extension in:
  ~/.pi/agent/scryer/projects.json

This helper maintains on-demand per-project task indexes in:
  ~/.pi/agent/scryer/projects/<project_id>.json

Task IDs should be resolved from these JSON files, not by ad-hoc API searches.
If a project task index is missing or older than --max-age-seconds, this helper
refreshes that project's task list once, writes the JSON, then reads IDs from it.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

DEFAULT_BASE_URL = "http://100.105.192.98:43210"
CACHE_DIR = Path.home() / ".pi" / "agent" / "scryer"
PROJECTS_CACHE = CACHE_DIR / "projects.json"
PROJECT_TASKS_DIR = CACHE_DIR / "projects"
DEFAULT_MAX_AGE_SECONDS = 600


def base_url() -> str:
    return (os.environ.get("SCRYER_API_BASE_URL") or os.environ.get("PI_PM_API_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, sort_keys=True)
        f.write("\n")
    tmp.replace(path)


def api_get(path: str) -> Any:
    if not path.startswith("/"):
        path = "/" + path
    req = urllib.request.Request(base_url() + path, headers={"Accept": "application/json"}, method="GET")
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.loads(response.read())


def cache_age_seconds(path: Path) -> float | None:
    try:
        return time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return None


def load_projects_cache() -> dict[str, Any]:
    return load_json(PROJECTS_CACHE)


def normalize(s: str) -> str:
    return " ".join(s.lower().strip().split())


def find_project(query: str) -> dict[str, Any]:
    cache = load_projects_cache()
    projects = cache.get("projects", [])
    q = normalize(query)

    exact = [p for p in projects if normalize(str(p.get("name", ""))) == q or str(p.get("id", "")) == query]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise SystemExit(json.dumps({"error": "ambiguous_project", "matches": exact}, indent=2))

    contains = [p for p in projects if q in normalize(str(p.get("name", "")))]
    if len(contains) == 1:
        return contains[0]
    if contains:
        raise SystemExit(json.dumps({"error": "ambiguous_project", "matches": contains}, indent=2))

    raise SystemExit(json.dumps({"error": "project_not_found_in_cache", "query": query}, indent=2))


def project_tasks_path(project_id: str) -> Path:
    safe = project_id.replace("/", "_")
    return PROJECT_TASKS_DIR / f"{safe}.json"


def slim_task(task: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": task.get("id"),
        "title": task.get("title"),
        "status": task.get("status"),
        "project_id": task.get("project_id"),
        "parent_task_id": task.get("parent_task_id"),
        "task_type_id": task.get("task_type_id"),
        "display_order": task.get("display_order"),
        "updated_at": task.get("updated_at"),
        "created_at": task.get("created_at"),
        "tags": [t.get("name") for t in task.get("tags", []) if isinstance(t, dict) and t.get("name")],
    }


def refresh_project_tasks(project_id: str, project_name: str | None = None) -> dict[str, Any]:
    encoded = urllib.parse.quote(project_id, safe="")
    tasks = api_get(f"/api/projects/{encoded}/tasks")
    data = {
        "base_url": base_url(),
        "project_id": project_id,
        "project_name": project_name,
        "updated_at": now_iso(),
        "max_age_seconds": DEFAULT_MAX_AGE_SECONDS,
        "tasks": [slim_task(t) for t in tasks],
    }
    write_json(project_tasks_path(project_id), data)
    return data


def ensure_project_tasks(project_id: str, project_name: str | None, max_age_seconds: int) -> dict[str, Any]:
    path = project_tasks_path(project_id)
    age = cache_age_seconds(path)
    if age is None or age > max_age_seconds:
        return refresh_project_tasks(project_id, project_name)
    return load_json(path)


def find_task(project_id: str, query: str, max_age_seconds: int, project_name: str | None = None) -> dict[str, Any]:
    data = ensure_project_tasks(project_id, project_name, max_age_seconds)
    tasks = data.get("tasks", [])
    q = normalize(query)

    exact = [t for t in tasks if str(t.get("id", "")) == query or normalize(str(t.get("title", ""))) == q]
    if len(exact) == 1:
        return exact[0]
    if len(exact) > 1:
        raise SystemExit(json.dumps({"error": "ambiguous_task", "matches": exact}, indent=2))

    contains = [t for t in tasks if q in normalize(str(t.get("title", "")))]
    if len(contains) == 1:
        return contains[0]
    if contains:
        raise SystemExit(json.dumps({"error": "ambiguous_task", "matches": contains}, indent=2))

    # Refresh once even if the cache was fresh, then search the refreshed JSON.
    data = refresh_project_tasks(project_id, project_name)
    tasks = data.get("tasks", [])
    exact = [t for t in tasks if str(t.get("id", "")) == query or normalize(str(t.get("title", ""))) == q]
    contains = [t for t in tasks if q in normalize(str(t.get("title", "")))] if not exact else []
    matches = exact or contains
    if len(matches) == 1:
        return matches[0]
    if matches:
        raise SystemExit(json.dumps({"error": "ambiguous_task_after_refresh", "matches": matches}, indent=2))
    raise SystemExit(json.dumps({"error": "task_not_found_in_project_cache", "project_id": project_id, "query": query}, indent=2))


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve Scryer project/task IDs via local JSON caches")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("find-project", help="Resolve a project name/ID from ~/.pi/agent/scryer/projects.json")
    p.add_argument("query")

    p = sub.add_parser("refresh-project-tasks", help="Fetch one project's tasks and write its JSON index")
    p.add_argument("project_id")
    p.add_argument("--project-name")

    p = sub.add_parser("ensure-project-tasks", help="Refresh project task index if missing/stale, then print it")
    p.add_argument("project_id")
    p.add_argument("--project-name")
    p.add_argument("--max-age-seconds", type=int, default=DEFAULT_MAX_AGE_SECONDS)

    p = sub.add_parser("find-task", help="Resolve a task/ticket/story title or ID from a project's JSON index")
    p.add_argument("project_id")
    p.add_argument("query")
    p.add_argument("--project-name")
    p.add_argument("--max-age-seconds", type=int, default=DEFAULT_MAX_AGE_SECONDS)

    args = parser.parse_args()

    try:
        if args.command == "find-project":
            result = find_project(args.query)
        elif args.command == "refresh-project-tasks":
            result = refresh_project_tasks(args.project_id, args.project_name)
        elif args.command == "ensure-project-tasks":
            result = ensure_project_tasks(args.project_id, args.project_name, args.max_age_seconds)
        elif args.command == "find-task":
            result = find_task(args.project_id, args.query, args.max_age_seconds, args.project_name)
        else:
            parser.error("unknown command")
            return 2
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except FileNotFoundError as exc:
        print(json.dumps({"error": "cache_file_missing", "path": str(exc.filename or PROJECTS_CACHE)}, indent=2), file=sys.stderr)
        return 1
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        print(json.dumps({"error": "http_error", "status": exc.code, "reason": exc.reason, "body": body}, indent=2), file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(json.dumps({"error": "request_failed", "reason": str(exc)}, indent=2), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
