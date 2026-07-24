#!/usr/bin/env python3
"""Small stdlib helper for Scryer PM API calls.

Examples:
  python scryer_api.py GET /api/projects
  python scryer_api.py GET '/api/tasks?status=unopened'
  python scryer_api.py POST /api/comments --json '{"author_role":"pi-agent","author_instance_key":"pi","body_md":"hi","task_id":"..."}'
  python scryer_api.py PATCH /api/tasks/<id> --json '{"status":"in_execution"}'
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

try:
    from scryer_cache import touch_ticket_from_task
except Exception:  # Keep API helper usable even if cache helper import fails.
    touch_ticket_from_task = None

DEFAULT_BASE_URL = "http://100.105.192.98:43210"


def base_url() -> str:
    return (os.environ.get("SCRYER_API_BASE_URL") or os.environ.get("PI_PM_API_BASE_URL") or DEFAULT_BASE_URL).rstrip("/")


def build_url(path: str) -> str:
    if path.startswith("http://") or path.startswith("https://"):
        return path
    if not path.startswith("/"):
        path = "/" + path
    return base_url() + path


def main() -> int:
    parser = argparse.ArgumentParser(description="Call the Scryer PM API")
    parser.add_argument("method", help="HTTP method: GET, POST, PATCH, PUT, DELETE")
    parser.add_argument("path", help="API path, e.g. /api/projects or full URL")
    parser.add_argument("--json", dest="json_body", help="JSON request body")
    parser.add_argument("--raw", action="store_true", help="Print raw response instead of pretty JSON")
    args = parser.parse_args()

    method = args.method.upper()
    data = None
    headers = {"Accept": "application/json"}

    if args.json_body is not None:
      try:
          parsed = json.loads(args.json_body)
      except json.JSONDecodeError as exc:
          print(f"Invalid --json body: {exc}", file=sys.stderr)
          return 2
      data = json.dumps(parsed).encode("utf-8")
      headers["Content-Type"] = "application/json"

    request = urllib.request.Request(build_url(args.path), data=data, headers=headers, method=method)

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            status = response.status
    except urllib.error.HTTPError as exc:
        body = exc.read()
        print(f"HTTP {exc.code} {exc.reason}", file=sys.stderr)
        if body:
            try:
                print(json.dumps(json.loads(body), indent=2, sort_keys=True), file=sys.stderr)
            except Exception:
                print(body.decode("utf-8", "replace"), file=sys.stderr)
        return 1
    except urllib.error.URLError as exc:
        print(f"Request failed: {exc}", file=sys.stderr)
        return 1

    if not body:
        print(f"HTTP {status}")
        return 0

    parsed_response = None
    try:
        parsed_response = json.loads(body)
    except Exception:
        pass

    if touch_ticket_from_task and isinstance(parsed_response, dict):
        try:
            touch_ticket_from_task(parsed_response)
        except Exception:
            pass

    if args.raw:
        sys.stdout.buffer.write(body)
        return 0

    if parsed_response is not None:
        print(json.dumps(parsed_response, indent=2, sort_keys=True))
    else:
        print(body.decode("utf-8", "replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
