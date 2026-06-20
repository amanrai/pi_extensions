---
name: scryer-dev
description: "Use when developing or running the scryer-io repo: local dev commands, ports, architecture notes, checks, and Scryer Io implementation workflow."
---

# Scryer Io Development

Use this skill when working on the `scryer-io` repository.

## Repo

Local path:

```text
/Users/amanrai/Code/scryer-io
```

GitHub:

```text
https://github.com/amanrai/scryer-io
```

Scryer Io is an agent-augmented notebook workbench with swappable Jupyter-backed execution targets.

## Install

```bash
cd /Users/amanrai/Code/scryer-io
npm install
```

## Run local dev stack

```bash
cd /Users/amanrai/Code/scryer-io
npm run dev
```

This starts:

- frontend: `http://127.0.0.1:54321`
- backend API: `http://127.0.0.1:54322`

The Vite frontend proxies `/api/*` to the backend on `54322`. Browser code should not talk directly to provider APIs; route through the local Scryer Io API server.

## Individual commands

Backend only:

```bash
npm run dev:api
```

Frontend only:

```bash
npm run dev:web
```

Override backend port:

```bash
SCRYER_IO_API_PORT=54322 npm run dev:api
```

Checks:

```bash
npm run typecheck
npm run build
```

Preview:

```bash
npm run preview
```

## Core architecture notes

Scryer Io treats every Jupyter backend as a remote endpoint. A local Jupyter server is just the nearest remote.

A provider profile describes an endpoint:

```ts
const profile = {
  id: "remote",
  kind: "jupyter",
  label: "Remote Jupyter",
  baseUrl: "http://127.0.0.1:8888/",
  auth: { kind: "token", token: "..." },
  defaultKernelName: "python3",
} as const;
```

The runtime client should support:

- list kernel specs
- list sessions
- start/connect sessions
- execute code
- interrupt/restart/shutdown kernels

Future provider targets include local machines, tailnet hosts, Vast instances, SageMaker notebooks, and Colab-like environments.

## Development workflow

- Read `README.md` and `docs/current-state.md` before major changes.
- Keep frontend/backend boundaries clear.
- Add or update types when changing API payloads.
- Run `npm run typecheck` after TypeScript changes.
- Run `npm run build` before final handoff when feasible.
- Tie work back to the active Scryer PM ticket when one is selected.
