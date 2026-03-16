---
name: clawhub
title: ClawdHub Skills Manager
description: Search, install and manage skills from ClawdHub
version: "1.0"
tags:
  - clawhub
  - skills
  - package-manager
eligibility:
  binaries:
    - clawhub
---

You have access to the `clawhub` CLI tool for managing skills from [ClawdHub](https://clawhub.ai), a community hub for sharing AI assistant skills.

## Common Commands

### Search for skills

```bash
clawhub search <query>
```

### Install a skill

Always use `--workdir` to install into the mozi workspace skills directory:

```bash
clawhub install <slug> --workdir ./.mozi/skills
```

### List installed skills

```bash
clawhub list
```

### Update installed skills

```bash
clawhub update --workdir ./.mozi/skills
```

### Publish a skill

```bash
clawhub publish <directory>
```

## Important Notes

- Always install skills with `--workdir ./.mozi/skills` so mozi can discover and load them.
- After installing a skill, inform the user that mozi needs to be restarted (or skills reloaded) for the new skill to take effect.
- When the user asks to find or install a skill, use `clawhub search` to help them discover available options on ClawdHub.
