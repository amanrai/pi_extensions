---
name: pi-extensions-dev
description: "Use when maintaining Aman's pi_extensions package: adding extensions or skills, checking in changes, pushing to GitHub, and updating the installed Pi package without leaving local-only changes."
---

# Pi Extensions Development

Use this skill when modifying `/Users/amanrai/Code/pi_extensions`.

## Repo and install model

Local dev repo:

```text
/Users/amanrai/Code/pi_extensions
```

Installed Pi package:

```text
~/.pi/agent/git/github.com/amanrai/pi_extensions
```

Package source in Pi settings:

```text
git:github.com/amanrai/pi_extensions
```

This package provides Pi extensions and skills through `package.json`:

```json
{
  "pi": {
    "extensions": ["./extensions"],
    "skills": ["./skills"]
  }
}
```

## Rule: no local-only changes

When the user asks to change this package, make changes in the local repo, then:

1. inspect diff
2. commit
3. push to GitHub
4. update installed package with `pi update`
5. verify local repo is clean

Do not leave uncommitted local changes unless the user explicitly asks.

## Standard workflow

```bash
cd /Users/amanrai/Code/pi_extensions
git status --short --branch
# edit files
git diff
git add <files>
git commit -m "Clear message"
git push origin main
pi update git:github.com/amanrai/pi_extensions
git status --short --branch
```

## Add a skill

Skills live under:

```text
skills/<skill-name>/SKILL.md
```

Frontmatter must be valid YAML:

```markdown
---
name: skill-name
description: "Quoted description if it contains a colon: like this."
---
```

Rules:

- `name` is lowercase letters, numbers, and hyphens only.
- Quote descriptions containing colons.
- Keep descriptions specific because Pi uses them to decide when to load the skill.
- Avoid secrets in skills.

## Add or edit an extension

Extensions live under:

```text
extensions/
```

Single-file extensions can be `extensions/name.ts`. Multi-file extensions should use a directory with `index.ts`.

Use package peer imports for Pi APIs:

- `@earendil-works/pi-coding-agent`
- `@earendil-works/pi-tui`
- `@earendil-works/pi-ai`
- `typebox`

Some existing files still import `@mariozechner/*`; be careful when modernizing because installed package versions may matter.

## Test locally before install

Temporary run:

```bash
pi -e /Users/amanrai/Code/pi_extensions
```

Installed package update:

```bash
pi update git:github.com/amanrai/pi_extensions
```

Reload in running Pi:

```text
/reload
```

## Validate skill install

After update, verify files in:

```bash
find ~/.pi/agent/git/github.com/amanrai/pi_extensions/skills -maxdepth 2 -name SKILL.md
```

If Pi reports skill conflicts or YAML errors, fix frontmatter, commit, push, and update again.
