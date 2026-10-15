# pi_extensions

Personal [pi](https://github.com/badlogic/pi-mono) extension package.

## Extensions

- `scryer/` — Scryer PM context, project/ticket selection (`/pp <project_id>`, `/tp <ticket_id>` with picker fallback), `/save`, `/update`, `/deets`, and recorder autosave.
- `comms/` — Scryer interaction-service producer/consumer: emits producer markers, polls interaction requests/responses, and renders cockpit-style TUI prompts.
- `read-md.ts` — `/read [path]` and `ctrl+k` Markdown picker/viewer for human reading, no LM context injection.
- `smart-status.ts` — `/status` command with model/context/session usage and Codex quota bars.
- `switch-to.ts` — `/switchTo` command to pick a session for the current folder and resume from a tree point.
- `starship-footer.ts` — Starship-powered footer with `agent_name@folder` from the startup `.scryer`, PR link, model, thinking level, tokens, and Codex subscription-aware cost display.
- `pi-codex-account` — bundled third-party `/codex` account-profile commands for saving, switching, and checking usage of named OpenAI Codex logins.

## Folder identity startup

`comms` initializes `.scryer` in the exact folder where Pi starts, independently of parent folders. It reuses the sole `created_by` identity, or generates an `adjective_noun_<12 random lowercase letters>` name from bundled word lists and cryptographically uniform random choices. Keep `.scryer` checked into Git. Existing names are not renamed.

```json
{
  "created_by": [{
    "name": "quiet_badger_abcdefghijkl",
    "machine_name": "creator-machine",
    "tailnet_name": "creator-tailnet",
    "repo": "git@github.com/example/repo",
    "created_at": "2026-10-15T00:00:00.000Z",
    "session": "pi-session:example"
  }],
  "command_runner": [],
  "file_modifier": [],
  "version-manager": []
}
```

Machine, tailnet, and repo fields are optional. `tailnet_name` is the creator machine's Tailscale DNS name without the trailing dot (falling back to its Tailscale host name), not the logged-in account or network name. Machine and tailnet record the creator's environment and are not replaced by later sessions. Creator repo metadata uses a normalized origin key, or the local Git root if no portable origin exists; startup refreshes it when available. Background discovery also refreshes it when an origin appears. Creation time and session remain unchanged.

Every update sends the full startup name, including its suffix, in `metadata.v2meta.identity`, including discussion-only and test updates. Only the Starship footer hides the twelve-letter suffix (and legacy four-hex suffixes). Existing metadata is preserved; full `.scryer` records and the old `identities` list are not sent. Updates require successful startup identity initialization. The existing producer UUID remains the session-routing identifier; its startup marker also exposes the identity name.

`.scryer` keeps action history separately. Action entries contain `name` and a `touched_at` list of UTC hours such as `2026-10-15T02Z`; old name-only entries remain readable. Startup does not add action entries. Automatic `.scryer` action-list maintenance is not implemented yet.

## Identity registration

Every startup/reload/resume registers with `POST /api/identities` at the interaction service:

```json
{
  "name": "quiet_badger_abcdefghijkl",
  "session": "pi-session:<Pi session ID>",
  "location": "machine:thinkpad.tailnet.ts.net@/home/amanrai/Code/project",
  "repo": "git@github.com/example/repo"
}
```

- The session ID comes from Pi's runtime, including before the session file exists, and remains stable on resume. The existing producer UUID remains separate and unchanged.
- Always send the current machine and absolute startup path, even with a repo. Tailscale machine names use the same hostname fallback as update folder metadata.
- `repo` is optional. SSH/HTTPS/SCP remotes normalize to `git@host/owner/repo`, without credentials, query strings, a trailing slash or `.git`; GitHub path case is folded. Custom ports and case-sensitive paths on other hosts are retained. Local-only remotes/Git roots do not become portable repo keys.
- The registry stores one optional repo, multiple sessions and deduplicated machine/path locations per identity. `201` creates an identity/session; `200` acknowledges an existing identity, including exact retries and repo/location updates. No collision renaming, ownership token, concurrency detection, or exclusivity constraint is introduced.
- Registration runs in the background with a 10-second request timeout and ordinary 30-second retries. Updates proceed independently. Acknowledgment is only in memory; there is no `.scryer` registration-status field.
- Git metadata is checked every 30 seconds and after successful Bash/edit/write results. A newly initialized repo becomes portable once an origin is available; discovery refreshes `.scryer` repo metadata and re-registers the same identity/session. Unchanged acknowledged payloads do not repeat HTTP requests, and temporary absence does not erase a known repo.
- Shutdown/reload cancels pending registration and its timer. No existing identity is renamed or deleted.

## Folders in updates

Every update includes `metadata.v2meta.foldersTouched`, for example:

```json
{
  "identity": "quiet_badger_abcdefghijkl",
  "foldersTouched": ["thinkpad.tailnet.ts.net:/home/amanrai/Code/project/src"]
}
```

- The extension observes successful `edit`/`write` results and allowlisted state-changing `bash` commands. Reads, read-only commands, and failed tool results do not produce observations.
- The initial command list covers file operations (`touch`, `mkdir`, `cp`, `mv`, `rm`, `ln`, `truncate`, `chmod`, `chown`), in-place `sed`/`perl`, patches, file-output redirection/`tee`, identifiable Python/Node writes, and Git commits.
- Command observations include the execution folder and statically identifiable affected folders. `cd` and `git -C` are resolved. Scripts are inspected, never executed by the tracker.
- This is a conservative command-list heuristic, not a filesystem audit. Unsupported control flow/subshells are skipped; computed paths and indirect writes may not be identified. Successful no-op mutators may still count. Partial changes from failed tools are not tracked.
- The update generator references observation IDs for the particular update it describes; the extension resolves those IDs to paths. It cannot invent paths. Discussion-only updates have an empty list.
- Paths use the **current machine's** Tailscale DNS name (without its trailing dot), falling back to its Tailscale host name, then local hostname—not the identity creator's machine.
- Observations and sent markers live in branch-local Pi session entries. Reload/resume retains pending observations without replaying sent ones; touches arriving during inference are left for the next batch.

Tests (Node 22.19+): `node --experimental-strip-types --test tests/*.test.ts`. To include the mocked Pi runtime integration test, set `PI_TEST_AGENT_ROOT` to the installed `@earendil-works/pi-coding-agent` package directory.

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

The comms extension defaults to `http://100.112.203.22:43217`. Override with `SCRYER_INTERACTIONS_URL` when needed. Its automatic interaction inference waits 30s by default; override startup default with `SCRYER_COMMS_INFERENCE_DELAY_MS` or current-session delay with `/comms-delay <seconds>`. Its semantic update inference runs in batches every 3 user turns by default; override startup default with `SCRYER_COMMS_UPDATE_BATCH_TURNS` or current-session batch size with `/comms-update-delay <turns>`.

Comms also lazily writes emitted semantic updates to one Scryer PM task per Pi session under the `Agent Sessions` project. It updates the task `description_md` only, never per-update comments. Override project lookup with `SCRYER_SESSIONS_PROJECT_ID` or `SCRYER_SESSIONS_PROJECT_SLUG`; override task type with `SCRYER_SESSIONS_TASK_TYPE_ID`.

`starship-footer.ts` expects `starship` in PATH. It uses `gh` when available to show the current branch PR number, and shows the current session's latest touched commit.
