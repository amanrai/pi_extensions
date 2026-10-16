# pi_extensions

Personal [pi](https://github.com/badlogic/pi-mono) extension package.

## Extensions

- `scryer/` — Scryer PM context, project/ticket selection (`/pp <project_id>`, `/tp <ticket_id>` with picker fallback), `/save`, `/update`, `/deets`, and recorder autosave.
- `comms/` — Scryer interaction-service producer/consumer: emits producer markers, polls interaction requests/responses, and renders cockpit-style TUI prompts.
- `matrix-screensaver/` — optional native Matrix rain after one minute idle; always starts disabled. Enable with `/matrix on`, stop with `/matrix off`.
- `goal-orientation/` — `pi --goal` starts an interactive Goal-orientation conversation using the reviewed wording in `prompts.ts`; ordinary startup is unchanged.
- `read-md.ts` — `/read [path]` and `ctrl+k` Markdown picker/viewer for human reading, no LM context injection.
- `smart-status.ts` — `/status` command with model/context/session usage and Codex quota bars.
- `switch-to.ts` — `/switchTo` command to pick a session for the current folder and resume from a tree point.
- `starship-footer.ts` — Starship-powered footer with `agent_name@folder` from the startup `.scryer`, PR link, model, thinking level, tokens, and Codex subscription-aware cost display.
- `pi-codex-account` — bundled third-party `/codex` account-profile commands for saving, switching, and checking usage of named OpenAI Codex logins.

## Session Goal tracking

The comms extension creates `.scryer-<main-Pi-session-id>` in the session header's startup directory, with empty `current`, `finish`, `complete`, and `abandon` arrays. Resume/reload preserves existing data; other sessions' files (including checked-in ones) are ignored. A context message supplies the exact path. Files may be committed. This state is session-wide, not rolled back on `/tree`.

Tools accept `{ "id": "GOAL_UUID", "title": "optional known title" }`:

- `goal_start` → `current`.
- `goal_finish` → `finish` (no longer working on it).
- `goal_complete` → `complete` (Goal accomplished).
- `goal_abandon` → `abandon`.

A transition removes that UUID from every list and puts it only in the destination. No-op calls emit nothing. Writes are serialized and atomically published. Tools do not decide intent or update PM records. Titles are retained on moves; an unknown title uses the UUID, without a PM lookup. Missing/invalid files are not silently repaired by tools.

Every update includes `metadata.v2meta.goals`, copied from `current` at publication time, not inferred from narrative. Missing/invalid/unreadable files warn visibly (stderr outside UI mode) and send `goals: []` without blocking delivery/session. Recap retries retain each part's first-attempt snapshot so stable-ID readback still works. Identity and other metadata are preserved. Observer prompts, schedule and independent reporting remain unchanged.

Actual transitions additionally publish content-free `progress` events with one of `metadata.v2meta.goal_start`, `goal_finish`, `goal_complete`, or `goal_abandon` set to the UUID. They bypass observer inference, semantic-update throttling and PM session-note mirroring. **The interactions service must support empty title/body on valid transition events** (companion scryer-interactions change). If delivery fails, the local move remains committed and a warning/tool result reports the failure. No durable event outbox or exactly-once guarantee is provided; retrying the unchanged move does not resend.

## Goal-oriented startup

Run `pi --goal` to have the agent announce its name from the startup folder's `.scryer` creator identity as a friendly name (for example, `Impressed Harrier`, without the random suffix), identify its startup directory, and ask which Goal to orient to. The extension composes the reviewed startup prompt in `extensions/goal-orientation/prompts.ts` and sends it as an extension-authored context message that triggers one model turn. Read-only Git discovery supplies the repository root, origin remote (with URL credentials/query tokens removed), and startup folder relative to that root. No repository or no origin is reported explicitly; these facts do not assign a project or Goal. It does not impersonate user input, prefetch Goals, write Goal associations, or authorize execution. The prompt explains where JEPM Goals live and how to retrieve them; numbered open-Goal lists are offered only if asked and reflect recorded relationships through indented hierarchical labels (for example, `1. Fix Loom` and `1.a. Focus Mode`). Users can select by these labels without seeing UUIDs. After Goal selection, the prompt instructs the agent to send an interaction-service update containing its name and the selected Goal's title and UUID. This reporting is a prompt instruction, not an automatic selection detector. Planning is distinct from execution: the agent offers collaborative checklist planning when no open todo list exists, and ordinary execution requires an approved checklist. An explicit user request may authorize work without a pre-existing checklist; the agent then records what it does in that Goal's checklist, creating it if necessary, without expanding the authorized scope. Missing/invalid startup identities produce a warning instead of an invented name or parent-folder fallback. The resulting conversation requires the normal model/provider configuration.

During the initial orientation turn, Pi's built-in working indicator shows `Orienting…`; settling or shutting down clears the orientation label and restores normal working-indicator behavior. No separate spinner, timer or overlay is installed.

Plain `pi` does nothing extra. `/reload` and in-process saved-session switches do not replay the startup request. This initial trial is interactive-only; `--orient` and `--do` are not implemented yet.

## Matrix idle screensaver

- **Always starts disabled**, including startup, `/reload`, `/new`, `/resume`, and
  `/fork`. Nothing is persisted or enabled automatically in other windows.
- `/matrix on` enables the screensaver for the current Pi session. `/matrix off`
  immediately stops it; `/matrix` or `/matrix status` reports its current state.
- Disabled means no idle/animation timers, controller widget, input subscription,
  or screen writes from this extension—persistent PTY terminals remain quiet.
- When enabled, **60 seconds of complete inactivity** starts green Matrix rain.
  User input, model/message streaming, and tool activity reset the clock. Active
  agent runs (including retries), queued messages, editor drafts, compaction, and
  extension dialogs prevent display. Existing overlays are not covered.
- Any wake-up key (including Enter/Ctrl+C or a pasted chunk) dismisses the animation
  **without sending it to the editor or model**; subsequent typing works normally.
  Terminal capability/cell-size replies are passed back to Pi, not treated as keys.
  Resumed work or another focused dialog closes only the screensaver's own overlay.
- Native Pi overlays use ASCII glyphs and standard ANSI colors at about 12 FPS;
  both regular and fullscreen renderers resize normally. No `cmatrix` installation,
  subprocess, external package, model call, network request, or platform-specific
  command is needed on **macOS or Linux**. It is a visual overlay, not a screen lock.
- Non-interactive/JSON/RPC modes do not start it. Turning it off, exiting, reloading,
  or switching sessions removes its overlay and cancels its timers/listener.
  Background comms polling and recap/update delivery continue independently.

Tests include deterministic idle timing, opt-in/reset behavior, animation sizing,
input consumption, and both real Pi TUI backends with an in-memory terminal.
Validated on Linux; a native macOS terminal visual check is still outstanding.

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

`.scryer` action history is maintained automatically from successful tool results, independently of model-generated updates. Entries use the session's startup identity and a deduplicated, sorted `touched_at` list of UTC hours such as `2026-10-15T02Z`. Legacy name-only entries are upgraded when that agent next touches the role; other agents and creator provenance are preserved. Startup alone does not add action entries.

- `edit`/`write` add `file_modifier` in the file's containing folder, not `command_runner`.
- Allowlisted state-changing Bash commands add `command_runner` in their execution folder (including recognized `cd`/`git -C`), and `file_modifier` in affected folders. When script targets cannot be resolved, execution-folder attribution is the fallback.
- Git commits add `command_runner` and, only when before/after HEAD differs, `version-manager`. Commits alone do not add `file_modifier`. Recording occurs after success: the new provenance can be included in the next commit, without automatic amendments or extra commits.
- Reads, read-only commands, failed tool results, help and dry-run commands do not add actions. The command allowlist is conservative, not an exhaustive shell interpreter or filesystem audit; unsupported control flow is skipped and concurrent external work is not ownership-policed.
- Missing records in touched folders start with empty `created_by` and only the observed action lists, plus top-level `created_at`, `session`, and optional `repo`. No extra identity is generated outside startup. If a Pi session later starts there, it initializes the sole creator without discarding action history. Deleted folders are not recreated for bookkeeping.
- Repo discovery refreshes the appropriate record when a repo becomes available. Cross-process lock files and atomic replacement protect read/modify/write; malformed records are never overwritten and errors are reported.

Keep `.scryer` files checked into Git and use agent identity front matter in commit messages. Automatic attribution does not stage files, rewrite commit messages, install Git hooks, or commit on the user's behalf.

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

## Coding notes

`<coding>...</coding>` is reserved for updates describing actual code changes.
A model's `coding: true` is not sufficient: the update must select an observation
with `codeChanged: true`. Successful no-ops, existing dirty files, planning,
discussion, read-only reviews, test/build runs, commits/pushes without another code
change, and recaps do not qualify. An explicit `coding: false` remains plain.

Before/after byte fingerprints provide evidence for recognized source/script files
(including tests) changed by `edit`/`write`, and by allowlisted Bash mutations inside
Git repos. Markdown, `.scryer`, and other non-code files do not supply coding evidence.
This is conservative observation, not filesystem auditing: unsupported commands,
ignored files, files over 2 MiB, and Bash scopes with over 2,000 files may be missed.
Concurrent writes are not policed or attributed with ownership locks.

Existing outer wrappers are stripped before applying the evidence-based flag, so a
model cannot bypass the gate by adding tags itself. Ordinary updates retain their
1,200-character body limit, reserving room for both tags when applicable. The same
body reaches the append-only update log and session-task mirror. Requested notes
must contain the note itself; revisions produce new updates, never rewrite history.

## Idle flush and recaps

- After **30 seconds without user/model/tool activity**, pending ordinary semantic
  updates are flushed independently of whether interaction inference proposes a
  prompt. The ordinary three-user-turn batching still applies while working.
- After **30 minutes idle**, an update titled **`Idle Recap — …`** covers the **full
  rolling last 12 hours**, not just the delta since the previous recap. Titles of
  multipart recaps all begin `Idle Recap`; bodies are always untagged.
- History belongs to **this running Pi window**, scoped to the current machine and
  local Git root (or startup folder when no repo exists). It spans `/new`, `/resume`,
  `/fork`, and `/reload`, but never imports saved history from another window or
  aggregates by persistent identity. Capture begins when this version is enabled;
  quitting Pi ends that window's history. Only the last 12 hours remain in memory.
- A recap requires new meaningful work/discussion since the last verified manual or
  automatic recap. No work, expired work, greetings, and logging/recap acknowledgments
  do not produce another recap. If new work exists, previously recapped work still
  appears when it is inside the 12-hour range.
- Terminal input, message streaming, model requests, and tools reset the idle clock.
  Active agent runs, queued messages, and editor drafts prevent idle jobs. Background
  comms polling, registration, update posting, and recap generation are not activity.
  Resumed activity cancels automatic recap generation; shutdown cancels timers/work.
- Long source histories are processed in bounded segments rather than silently
  dropping older context. Recap bodies bypass the ordinary update truncation limit.
  Every part is read back in full, including metadata, before acknowledgment.
  Partial deliveries retain stable IDs and verified receipts across reload/session
  switches, retrying after transient failures without creating duplicate update rows.
  No checkpoint advances until every part is verified. PM mirroring remains best-effort.
- Use the model-callable **`send_recap`** tool for requested manual recaps, supplying
  `title` and complete `parts: string[]`. It performs the same untagged, full-storage
  verification and advances this window/repo's shared recap checkpoint. Direct HTTP
  writes bypass this local checkpoint; use the tool instead.

The two idle jobs are terminal-UI behavior. Ordinary semantic batching and manual
recap delivery remain available in non-interactive modes. Interaction inference is
still separate; `/comms-delay` changes its delay, not either idle timer.

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
