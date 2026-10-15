# pi_extensions

Personal [pi](https://github.com/badlogic/pi-mono) extension package.

## Extensions

- `scryer/` — Scryer PM context, project/ticket selection (`/pp <project_id>`, `/tp <ticket_id>` with picker fallback), `/save`, `/update`, `/deets`, and recorder autosave.
- `comms/` — Scryer interaction-service producer/consumer: emits producer markers, polls interaction requests/responses, and renders cockpit-style TUI prompts.
- `read-md.ts` — `/read [path]` and `ctrl+k` Markdown picker/viewer for human reading, no LM context injection.
- `smart-status.ts` — `/status` command with model/context/session usage and Codex quota bars.
- `switch-to.ts` — `/switchTo` command to pick a session for the current folder and resume from a tree point.
- `starship-footer.ts` — Starship-powered footer with pwd, PR link, model, thinking level, tokens, and Codex subscription-aware cost display.
- `pi-codex-account` — bundled third-party `/codex` account-profile commands for saving, switching, and checking usage of named OpenAI Codex logins.

## Folder identity startup

`comms` initializes `.scryer` in the exact folder where Pi starts, independently of parent folders. It reuses the sole `created_by` identity, or generates an `adjective_noun` name from bundled word lists. Keep `.scryer` checked into Git.

```json
{
  "created_by": [{
    "name": "quiet_badger",
    "machine_name": "creator-machine",
    "tailnet_name": "creator-tailnet",
    "repo": "https://github.com/example/repo.git",
    "created_at": "2026-10-15T00:00:00.000Z",
    "session": "pi-session:example"
  }],
  "command_runner": [],
  "file_modifier": [],
  "version-manager": []
}
```

Machine, tailnet, and repo fields are optional. Machine and tailnet record the creator's environment and are not replaced by later sessions. Repo detection uses the origin URL, or the local Git root if no origin exists; a later startup refreshes it when available. Creation time and session remain unchanged.

Startup does not add entries to the action lists. Action tracking and `metadata.v2meta.identities` publishing are not implemented yet. The existing producer UUID remains the session-routing identifier; its startup marker also exposes the identity name.

Tests: `node --experimental-strip-types --test tests/comms-identity.test.ts` (Node 22.19+).

## Install

```bash
pi install git:github.com/amanrai/pi_extensions.git
```

For local development:

```bash
pi install /home/amanrai/Code/pi_extensions
# or test temporarily
pi -e /home/amanrai/Code/pi_extensions
```

Reload in pi:

```text
/reload
```

## Notes

PM integrations default to `http://smux-linode:43210` over Tailscale. The comms extension accepts `SCRYER_PM_URL`; the footer accepts `PI_PM_API_BASE_URL`; PM skill helpers accept `SCRYER_API_BASE_URL` or `PI_PM_API_BASE_URL` (in that order). Existing overrides still take precedence. If MagicDNS is unavailable on a client, use `http://100.114.138.79:43210` in the applicable override(s).

The canonical local development checkout is `/Users/amanrai/Code/common-volume/repos/pi_extensions`. The installed Pi package remains at `~/.pi/agent/git/github.com/amanrai/pi_extensions`; publish changes and run `pi update git:github.com/amanrai/pi_extensions`, then `/reload` in the active Pi session.

The comms extension defaults to `http://100.105.192.98:43217`. Override with `SCRYER_INTERACTIONS_URL` when needed. Its automatic interaction inference waits 30s by default; override startup default with `SCRYER_COMMS_INFERENCE_DELAY_MS` or current-session delay with `/comms-delay <seconds>`. Its semantic update inference runs in batches every 3 user turns by default; override startup default with `SCRYER_COMMS_UPDATE_BATCH_TURNS` or current-session batch size with `/comms-update-delay <turns>`.

Comms also lazily writes emitted semantic updates to one Scryer PM task per Pi session under the `Agent Sessions` project. It updates the task `description_md` only, never per-update comments. Override project lookup with `SCRYER_SESSIONS_PROJECT_ID` or `SCRYER_SESSIONS_PROJECT_SLUG`; override task type with `SCRYER_SESSIONS_TASK_TYPE_ID`.

`starship-footer.ts` expects `starship` in PATH. It uses `gh` when available to show the current branch PR number, and shows the current session's latest touched commit.
