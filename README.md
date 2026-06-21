# pi_extensions

Personal [pi](https://github.com/badlogic/pi-mono) extension package.

## Extensions

- `scryer/` — Scryer PM context, project/ticket pickers, `/save`, `/update`, `/deets`, and recorder autosave.
- `comms/` — Scryer interaction-service producer/consumer: emits producer markers, polls interaction requests/responses, and renders cockpit-style TUI prompts.
- `read-md.ts` — `/read [path]` and `ctrl+k` Markdown picker/viewer for human reading, no LM context injection.
- `smart-status.ts` — `/status` command with model/context/session usage and Codex quota bars.
- `switch-to.ts` — `/switchTo` command to pick a session for the current folder and resume from a tree point.
- `starship-footer.ts` — Starship-powered footer with pwd, PR link, model, thinking level, tokens, and Codex subscription-aware cost display.

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

The Scryer PM extension defaults to `http://100.105.192.98:43210`. Override with `SCRYER_PM_URL` when needed.

The comms extension defaults to `http://127.0.0.1:43217`. Override with `SCRYER_INTERACTIONS_URL` when needed. Its automatic interaction inference waits 30s by default; override startup default with `SCRYER_COMMS_INFERENCE_DELAY_MS` or current-session delay with `/comms-delay <seconds>`. Its semantic walkaway-update inference waits 8s by default; override startup default with `SCRYER_COMMS_UPDATE_DELAY_MS` or current-session delay with `/comms-update-delay <seconds>`.

`starship-footer.ts` expects `starship` in PATH. It uses `gh` when available to show the current branch PR number, and shows the current session's latest touched commit.
