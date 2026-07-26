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
| `node index.mjs <dir> --add-modules <ids>`                                 | Add modules to an app generated earlier   |

Before considering a change done: generate one app per registered starter from a local checkout and run the generated app's own CI pipeline (`format:check`, `lint`, `test:coverage`, `build`, plus `e2e`/Storybook where applicable). Also exercise one error path (e.g. `--template` on a directory without a manifest). For a change touching `applyManifest`, `--add-modules`, or the diff/patch helpers, additionally generate an app with a module left out, run `--add-modules` to add it back, and build the result — this is the only way to catch a patch that silently applies at the wrong place.

## Architecture

- `REGISTRY` (top of [index.mjs](index.mjs)) — the known starters (`id` → git URL). Adding a starter to the registry requires nothing else here, but the starter repo must carry its manifest.
- Flow order matters: the template is **fetched before the questions**, because the prompts depend on the manifest (`prompts`, `modules`, `openapiTarget`, `nameSuffix`, `install`). Do not move prompts before the fetch.
- Manifest application order is part of the contract: `remove` → `rename` → `jsonPatch` → `replace` → `replaceAll` → render templates → resolve module markers → copy `--openapi` spec → delete `generator.config.json` + `.generator/`. `remove` uses literal repository paths; from `rename` onward, paths and values are token-substituted.
- Optional modules (`modules.optional`) fold into that order rather than forming a phase of their own: a module left out contributes its `whenAbsent.remove` to the first step and its `whenAbsent.templates` tree to the render step. Its `markers` are resolved **after** the templates, so marked sections inside rendered README/AGENTS files are handled too — and they are resolved whether the module was kept or not, because a generated application must never ship a marker comment.
- Any entry of `rename`, `jsonPatch`, `replace`, `replaceAll` or `nextSteps` may carry a `module` field; the entry is then skipped when that module is absent. That is what keeps a legitimately-missing path from warning "template drift".
- `schema` (`SUPPORTED_SCHEMA`) versions the manifest contract: additive optional fields do not bump it; breaking changes bump it and the error message must tell users to update the generator.
- `applyManifest` (steps 4 above) is a standalone function, not inlined in the generate flow: `--add-modules` calls it twice more, into two throwaway scratch trees built with the application's _current_ modules and with those plus the requested ones, to isolate exactly what the new module(s) change (see README's "Adding modules later"). Keep it free of anything the generate flow alone needs (prompts, git, install) — those stay in `runGenerate`.
- `.starter-manifest.json` (`STATE_FILE`) is the one file `applyManifest` never deletes and the generate flow writes deliberately: template (resolved to an absolute path for a local dir, so `--add-modules` finds it from any cwd), tokens, and the modules chosen. It is what makes `--add-modules` possible at all — losing it (or a starter's own `remove`/`replaceAll` deleting or rewriting it) breaks that feature for the app.
- `--add-modules`'s patcher only ever inserts; it never edits or deletes existing lines. A shared file whose diff between the two scratch trees contains a `remove` op (not just `add`) — typically a `{{modules}}`-driven summary line — is reported for a manual look rather than patched, because guessing at a modification (not just where to insert) risks corrupting content the application may have since diverged from the template. An insertion's anchor is a short window of surrounding lines (`ANCHOR_WINDOW`), not a single line — poms and YAML repeat short lines (`</dependency>`, blank lines) constantly, and a single-line anchor would match the wrong occurrence, or none uniquely, far too often.

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
- `replaceAll` is a **literal substring** replacement with no word boundaries: a starter renaming `starter-batch` must anchor it (`>starter-batch<`), otherwise it also rewrites `spring-boot-starter-batch`. Marker resolution has the same shape, but matches whole lines only — markers sitting mid-line are ignored.
- The initial commit uses `--no-verify` on purpose: the project is freshly formatted and hooks (lint-staged, commitlint) belong to the first human commit.
- Starters must exclude `.generator/templates/` from their own Prettier/ESLint (token files are not valid syntax) — see the sync rules in each starter's AGENTS.md.
- On Windows, never copy a `node_modules` installed by pnpm (junctions into the global store break); reinstall instead.
