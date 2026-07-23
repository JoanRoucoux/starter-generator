# Contributing

Thanks for your interest in this project!

## Prerequisites

- Node.js LTS
- [pnpm](https://pnpm.io)
- `pnpm install` (installs the two runtime dependencies)

## Workflow

1. Create a branch from `main` (`feat/...`, `fix/...`).
2. Develop following the project conventions (see [AGENTS.md](../AGENTS.md#conventions)).
3. Check locally before committing:
   ```bash
   pnpm run lint
   pnpm run format:check
   ```
   There is no automated test suite: verify by generating an app from a local starter checkout and running its own quality gates (see [AGENTS.md](../AGENTS.md#commands)).
4. Commit using a [Conventional Commits](https://www.conventionalcommits.org) message (`feat: ...`, `fix: ...`, `chore: ...`), automatically validated by commitlint.
5. Open a Pull Request filling in the provided template.

## Git hooks

Husky automatically runs:

- **pre-commit**: formats and lints the staged files (lint-staged)
- **commit-msg**: validates the commit message (commitlint)

## Reporting a bug or requesting a feature

Use the issue templates available on GitHub.
