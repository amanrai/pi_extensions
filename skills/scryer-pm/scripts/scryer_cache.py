#!/usr/bin/env python3
"""Scryer local cache helper.

Project names/IDs are maintained by the Pi footer extension in:
  ~/.pi/agent/scryer/projects.json

This helper maintains on-demand per-project task indexes in:
  ~/.pi/agent/scryer/projects/<project_id>.json

Task IDs should be resolved by reading these JSON files. This helper only
refreshes/ensures the per-project JSON index; it does not select task IDs.
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


def ensure_project_tasks(project_id: str, project_name: str | None, max_age_seconds: int) -> tuple[dict[str, Any], bool]:
    path = project_tasks_path(project_id)
    age = cache_age_seconds(path)
    if age is None or age > max_age_seconds:
        return refresh_project_tasks(project_id, project_name), True
    return load_json(path), False


def task_cache_summary(data: dict[str, Any], refreshed: bool) -> dict[str, Any]:
    project_id = str(data.get("project_id", ""))
    return {
        "project_id": project_id,
        "project_name": data.get("project_name"),
        "updated_at": data.get("updated_at"),
        "task_count": len(data.get("tasks", [])),
        "refreshed": refreshed,
        "path": str(project_tasks_path(project_id)) if project_id else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Resolve Scryer project/task IDs via local JSON caches")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("find-project", help="Resolve a project name/ID from ~/.pi/agent/scryer/projects.json")
    p.add_argument("query")

    p = sub.add_parser("refresh-project-tasks", help="Fetch one project's tasks and write its JSON index")
    p.add_argument("project_id")
    p.add_argument("--project-name")

    p = sub.add_parser("ensure-project-tasks", help="Refresh project task index if missing/stale, then print a compact summary")
    p.add_argument("project_id")
    p.add_argument("--project-name")
    p.add_argument("--max-age-seconds", type=int, default=DEFAULT_MAX_AGE_SECONDS)

    args = parser.parse_args()

    try:
        if args.command == "find-project":
            result = find_project(args.query)
        elif args.command == "refresh-project-tasks":
            data = refresh_project_tasks(args.project_id, args.project_name)
            result = task_cache_summary(data, True)
        elif args.command == "ensure-project-tasks":
            data, refreshed = ensure_project_tasks(args.project_id, args.project_name, args.max_age_seconds)
            result = task_cache_summary(data, refreshed)
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
