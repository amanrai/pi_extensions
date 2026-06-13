# pi_extensions

Personal [pi](https://github.com/badlogic/pi-mono) extension package.

## Extensions

- `scryer/` — Scryer PM context, project/ticket pickers, `/save`, `/update`, `/deets`, and recorder autosave.
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

`starship-footer.ts` expects `starship` in PATH. It uses `gh` when available to show the current branch PR number, and shows the active work repo's latest commit.
