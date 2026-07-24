# AGENTS.md

Guidance for AI coding agents working in this repository. See the [README](README.md) for the full project overview and the manifest specification.

## Project

Generic CLI that generates applications from manifest-driven starter templates (`angular-starter-web`, `angular-starter-ui`, more later). Single-file Node ESM CLI ([index.mjs](index.mjs)), two runtime dependencies (`@clack/prompts`, `picocolors`), no build step, no TypeScript.

The core design rule: **the engine knows nothing about any specific starter.** Everything starter-specific lives in the starter repository (`generator.config.json` manifest + `.generator/templates/` scaffolds). If a change requires hardcoding a starter's path or name in the engine, the change is wrong — extend the manifest contract instead, and document it in the README.

## Commands

There is no test suite: verification means running the generator against a local starter checkout.

| Command                                                                    | Purpose                                   |
| -------------------------------------------------------------------------- | ----------------------------------------- |
| `pnpm install`                                                             | Install the two dependencies              |
| `node index.mjs <dir> --template <local-starter-dir> --yes --skip-install` | Fast structural check of a generation     |
| `node index.mjs <dir> --template <local-starter-dir> --yes`                | Full generation (install, format, commit) |

Before considering a change done: generate one app per registered starter from a local checkout and run the generated app's own CI pipeline (`format:check`, `lint`, `test:coverage`, `build`, plus `e2e`/Storybook where applicable). Also exercise one error path (e.g. `--template` on a directory without a manifest).

## Architecture

- `REGISTRY` (top of [index.mjs](index.mjs)) — the known starters (`id` → git URL). Adding a starter to the registry requires nothing else here, but the starter repo must carry its manifest.
- Flow order matters: the template is **fetched before the questions**, because the prompts depend on the manifest (`prompts`, `openapiTarget`, `nameSuffix`, `install`). Do not move prompts before the fetch.
- Manifest application order is part of the contract: `remove` → `rename` → `jsonPatch` → `replace` → `replaceAll` → render templates → copy `--openapi` spec → delete `generator.config.json` + `.generator/`. `remove` uses literal repository paths; from `rename` onward, paths and values are token-substituted.
- `schema` (`SUPPORTED_SCHEMA`) versions the manifest contract: additive optional fields do not bump it; breaking changes bump it and the error message must tell users to update the generator.

## Conventions

- Everything is written in **English** (code, comments, docs).
- Keep it dependency-light: prefer `node:` builtins; a new dependency needs a strong reason.
- `git` commands run **without a shell** (their arguments contain user input: paths, refs). Manifest commands (`install`, `postInstall`) run **through the shell** — they are trusted strings from the starter, whose code we execute anyway.
- Every drift the engine can detect (missing `replace` pattern, missing `jsonPatch` target, unknown `{{token}}`) warns with the words "template drift" rather than failing: generation should survive minor starter evolution, visibly.

## Gotchas

- Token substitution is strict `{{word}}` (no spaces): that is what lets Angular interpolation `{{ 'x' | transloco }}` in template files pass through untouched. Do not "improve" the regex to tolerate whitespace.
- `__token__` segments in template **paths** are fatal when unknown (unlike content tokens, which only warn). Template paths must therefore avoid accidental `__word__` sequences — a Flyway-style file name like `V2__create_x.sql` is fine, but `V2__create___feature__.sql` would parse `__create__` as an unknown token; keep such names to a single token occurrence.
- `rename` entries apply **sequentially** (each `from` sees the tree as left by the previous entries) and both sides are token-substituted; after a move, now-empty ancestor directories of `from` are pruned. Order entries parent-first.
- `replaceAll` skips `.generator/` on purpose: template files carry `{{tokens}}` that must survive until render. It also never touches binary extensions or the manifest itself.
- The initial commit uses `--no-verify` on purpose: the project is freshly formatted and hooks (lint-staged, commitlint) belong to the first human commit.
- Starters must exclude `.generator/templates/` from their own Prettier/ESLint (token files are not valid syntax) — see the sync rules in each starter's AGENTS.md.
- On Windows, never copy a `node_modules` installed by pnpm (junctions into the global store break); reinstall instead.
