---
name: clawhub
description: "Search, install, update, list, and publish skills using the clawhub CLI for the ClawdHub marketplace. Use when the user asks to find skills, install a skill, browse ClawdHub, manage installed skills, or publish a skill to ClawdHub."
version: "1.0"
metadata:
  tags:
    - clawhub
    - skills
    - package-manager
  eligibility:
    binaries:
      - clawhub
---

Manage skills from [ClawdHub](https://clawhub.ai) using the `clawhub` CLI.

## Commands

### Search for skills

```bash
clawhub search <query>
```

### Install a skill

Always target the mozi skills directory:

```bash
clawhub install <slug> --workdir ~/.mozi/skills
```

After install, verify it was added:

```bash
clawhub list
```

Then inform the user that mozi needs a restart (or skill reload) for the new skill to take effect.

### Update installed skills

```bash
clawhub update --workdir ~/.mozi/skills
```

### Publish a skill

```bash
clawhub publish <directory>
```

## Important Notes

- Always use `--workdir ~/.mozi/skills` for install and update so mozi can discover skills.
- Use `clawhub search` to help users discover available skills before installing.
