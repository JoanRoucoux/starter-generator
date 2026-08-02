# starter-generator

Generate new applications from manifest-driven starter templates.

```bash
starter-generator virement-web
```

The generator itself knows nothing about any specific starter: each starter repository **describes itself** through a `generator.config.json` manifest and `.generator/templates/` scaffold files. The generator is a generic engine that fetches a starter, applies its manifest, and bootstraps the result (git, install, first commit). Adding a new starter (e.g. a Java API starter) means adding a manifest to that repository and one line to the registry — no engine changes.

## Registered starters

| Id     | Starter                                                                   | Generates                                       |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------- |
| `web`  | [angular-starter-web](https://github.com/JoanRoucoux/angular-starter-web) | An Angular web application                      |
| `ui`   | [angular-starter-ui](https://github.com/JoanRoucoux/angular-starter-ui)   | An Angular design system (library + Storybook)  |
| `java` | [java-starter](https://github.com/JoanRoucoux/java-starter)               | A Spring Boot backend in hexagonal architecture |

## Usage

```bash
starter-generator [directory] [options]
```

| Option                   | Description                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `--starter <id>`         | Starter from the registry (prompted if omitted)                                            |
| `--template <repo\|dir>` | Template git URL or local directory (overrides `--starter`)                                |
| `--ref <branch\|tag>`    | Git ref to clone from the template repository                                              |
| `--name <kebab-case>`    | Application name (default: directory name without `-web`)                                  |
| `--title <text>`         | Display title, used in the generated app's UI and README                                   |
| `--feature <kebab-case>` | Initial feature name (default: application name)                                           |
| `--openapi <path\|url>`  | OpenAPI spec copied into the starter's declared `openapiTarget`                            |
| `--base-package <pkg>`   | Base package (e.g. `com.acme.payments`), for starters that prompt for one                  |
| `--modules <a,b>`        | Optional modules to include (`""` for none), for starters that declare some                |
| `--skip-install`         | Do not run the starter's install command                                                   |
| `--skip-git`             | Do not initialize a git repository                                                         |
| `--yes` / `-y`           | Non-interactive: accept defaults for anything not provided as a flag                       |
| `--add-modules <a,b>`    | Add modules to the application at `[directory]` — see below; every other option is ignored |

### Examples

```bash
# Interactive (prompts for starter, name, title, feature, OpenAPI spec)
starter-generator

# Fully scripted
starter-generator portfolio-web --starter web --name portfolio --title "Portfolio" \
  --openapi ../specs/portfolio-api.yaml --yes

# Spring Boot backend behind that frontend, same OpenAPI contract, database and batch included
starter-generator portfolio --starter java --base-package com.acme.portfolio \
  --modules schema,batch --openapi ../specs/portfolio-api.yaml --yes

# Same starter, no database at all: an API orchestrating external webservices
starter-generator portfolio --starter java --base-package com.acme.portfolio --modules "" --yes

# From an internal mirror, or a local checkout (offline / testing starter changes)
starter-generator virement-web --template git@git.internal.bank:frontend/angular-starter-web.git
starter-generator virement-web --template ../angular-starter-web
```

Without publishing to a registry, run it directly: `node starter-generator/index.mjs virement-web`.

## How a generation works

1. **Fetch** — `git clone --depth 1` of the starter repository, or a filtered copy when `--template` points to a local directory (`copyIgnore`).
2. **Validate** — the starter must contain a `generator.config.json` with a supported `schema`; clear error otherwise.
3. **Ask** — name and title always; the feature and base-package prompts only if the starter lists them in `prompts`; the module checklist only if it declares optional `modules`; the OpenAPI prompt only if it declares an `openapiTarget`.
4. **Apply the manifest, in order** — `remove` (plus the `whenAbsent.remove` of every module left out) → `rename` → `jsonPatch` → `replace` → `replaceAll` → render `.generator/templates/` and the `whenAbsent.templates` tree of every module left out (overwriting existing files) → resolve the module `markers` → copy the `--openapi` spec to `openapiTarget` → delete `generator.config.json` and `.generator/` from the result.
5. **Bootstrap** — `git init -b main`, the starter's `install` command, its `postInstall` commands, then an initial commit (`--no-verify`: the project is freshly formatted, hooks apply from the first human commit).

## Manifest specification (`generator.config.json`, schema 1)

Everything is optional except `schema`. From `rename` onward, both paths and values support `{{token}}` substitution — `remove` (and `whenAbsent.remove`) are the exception: they run before any rename and take literal repository paths.

Any entry of `rename`, `jsonPatch`, `replace`, `replaceAll` or `nextSteps` may carry a `"module": "<id>"` field: it then applies only when that module made it into the generated application, instead of warning about a path that is legitimately gone.

```jsonc
{
  "schema": 1, // manifest schema version (required)
  "starter": "angular-starter-web", // display name, used in the bootstrap commit message
  "nameSuffix": "-web", // stripped from the directory name to derive the default app name
  "prompts": ["feature"], // extra prompts this starter needs ("feature" and "basePackage" exist today)
  "modules": {
    // parts of the starter the user can leave out — see below
    "required": ["api", "core"], // informational: never removable, listed in the prompt and {{modules}}
    "optional": [{ "id": "schema", "default": true, "markers": [], "whenAbsent": {} }],
  },
  "copyIgnore": ["node_modules"], // excluded when the template is a local directory (.git always is)
  "remove": ["LICENSE"], // template-only files/dirs deleted from the generated app (literal repository paths)
  "rename": [
    // directory/file moves, applied sequentially: each `from` sees the tree as left by the
    // previous entries; both sides support {{token}} substitution
    { "from": "starter-api", "to": "{{appName}}-api" },
  ],
  "jsonPatch": [
    // shallow edits of JSON files
    { "file": "package.json", "set": { "name": "{{projectName}}" }, "delete": ["author"] },
  ],
  "replace": [
    // literal string replacement in one file
    { "file": "angular.json", "search": "angular-starter-web", "value": "{{projectName}}", "optional": false },
  ], // non-optional patterns warn "template drift" when missing
  "replaceAll": [
    // tree-wide literal replacement (skips .git, .generator/, the manifest and binary files);
    // `extensions` restricts to matching file extensions; a pattern found nowhere warns
    // "template drift" unless optional
    { "extensions": [".java", ".xml"], "search": "com.example.starter", "value": "{{basePackage}}" },
  ],
  "openapiTarget": "openapi/openapi.yaml", // where --openapi lands; omit if not applicable
  "install": "pnpm install", // install command (string, or platform-keyed object — see below)
  "postInstall": ["pnpm run format"], // commands run after a successful install
  "nextSteps": ["pnpm start"], // extra lines in the final recap (a line may be {"module":…,"text":…})
}
```

### Optional modules (`modules`)

A starter can declare parts of itself the user picks at generation time. `--modules a,b` selects them (`--modules ""` selects none); interactively they appear as a checklist; non-interactively the ones with `"default": true` are taken. An unknown id, or a module whose `requires` are not satisfied, is a fatal error.

```jsonc
{
  "id": "schema",
  "label": "schema", // shown in the checklist
  "hint": "PostgreSQL persistence and the Liquibase changelogs that own its schema",
  "default": true, // taken in non-interactive mode
  "requires": ["persistence"], // other optional modules this one cannot live without
  "markers": [
    // marker pairs framing the parts of shared files (poms, YAML, docs) that belong to this
    // module. Each marker sits alone on its line. Module left out: the whole span is removed.
    // Module kept: only the two marker lines are — a generated app never ships a marker.
    // `extensions` restricts the sweep; a pair found nowhere warns "template drift".
    { "extensions": [".xml", ".md"], "start": "<!-- module:schema -->", "end": "<!-- /module:schema -->" },
  ],
  "whenAbsent": {
    // applied only when the user leaves this module out
    "remove": ["compose.yaml"], // literal repository paths, deleted before any rename
    "templates": "without-schema", // extra scaffold tree (.generator/without-schema/) rendered
    // after .generator/templates/, for files this variant needs
    // that deletion alone cannot produce
  },
}
```

The `{{modules}}` token holds the included modules, required ones first, as a comma-separated list.

`install` and each `postInstall` entry are either a shell string or an object keyed by Node's `process.platform` with a `default` fallback — for commands that have no single cross-platform spelling, like the Maven wrapper:

```jsonc
"install": { "default": "./mvnw -ntp package", "win32": ".\\mvnw.cmd -ntp package" }
```

Spell Windows commands with an explicit `.\` prefix: environments that set `NoDefaultCurrentDirectoryInExePath` (Git Bash does) stop cmd.exe from finding bare `mvnw.cmd` in the working directory.

### Scaffold templates (`.generator/templates/`)

Files rendered over the generated app, overwriting existing files. The directory mirrors the app layout:

- **Path tokens**: `__feature__` in a path segment becomes the feature name (any token works: `__projectName__`, …).
- **Content tokens**: `{{token}}` placeholders, plain substitution — no conditional logic. Exact match only, so Angular's `{{ interpolation }}` (with spaces) is left untouched.
- Binary extensions (png, ico, fonts…) are copied as-is.

Available tokens: `projectName` (directory name), `appName`, `title`, `starterVersion` (from the template's package.json, when present) — plus, when the starter prompts for a feature: `feature`, `featurePascal`, `featureCamel`, `featureConst` (SNAKE_UPPER) — plus, when it prompts for a base package: `basePackage` (`com.acme.payments`) and `basePackagePath` (`com/acme/payments`; token values may contain `/`, so a single `__basePackagePath__` path segment expands to a nested directory) — plus, when it declares optional modules: `modules`.

Because template files contain tokens, they are not valid syntax: the starter must exclude `.generator/templates/` from its own formatters/linters (see the starter's `.prettierignore` and ESLint `globalIgnores`).

## Adding modules later

A generation writes one extra file the starter never sees: `.starter-manifest.json`, recording the template, the tokens answered and the modules chosen. It is the only thing that makes `--add-modules` possible, and it is the reason generation otherwise leaves no trace of its own manifest — `.starter-manifest.json` describes the _generation_, not the _starter_, so unlike `generator.config.json`/`.generator/` it ships in the result.

```bash
starter-generator portfolio --starter java --base-package com.acme.portfolio --modules "" --yes
# ... time passes, the application grows ...
starter-generator portfolio --add-modules schema
starter-generator portfolio --add-modules batch
```

Each call re-fetches the starter (the _current_ version — a starter that evolved since the original generation is what gets diffed against, not a snapshot of what generated the app) and generates two throwaway reference trees with the application's exact identity: one with today's modules, one with those plus the requested ones. Diffing them tells the tool exactly what the new module(s) contribute, with no guessing about starter internals:

- **New files or directories** (the bulk of any module's footprint, by design — see a starter's own conventions on keeping a module's slice self-contained) are copied straight into the application; a path that already exists there is left untouched and reported, never overwritten.
- **Shared files that only gained an inserted block** (a `<module>` line, a dependency, a YAML block) are patched in place, anchored on a short window of the surrounding unchanged lines — enough context that a single repeated closing tag (`</dependency>`, blank lines) is never mistaken for the insertion point.
- **Anything that isn't a clean insertion** — the same shared file also changed in a way that has nothing to do with the new module (typically a "generated with these modules: …" summary line) — is reported with a compact diff instead of guessed at. A wrong guess here would corrupt a file the application may have long since diverged from the template in; a flagged TODO costs the user thirty seconds instead.

`--add-modules` never touches git and never runs an install: it only changes files, so the result shows up in `git status`/`git diff` like any other edit, for the user to review and commit on their own terms. A module whose `requires` are not yet present, or one already part of the application, is a fatal error, same as at generation time.

## Adding a starter

1. In the starter repository: add `generator.config.json` (see specification) and, if needed, `.generator/templates/`.
2. Here: add one entry to `REGISTRY` in [index.mjs](index.mjs).

## Updating generated apps

Generation is one-shot: each application lives its own life afterwards. To pick up starter improvements in general, follow the starter's changelog and apply the relevant changes manually — `--add-modules` (above) is the one exception, for adding a module the application didn't start with.

## Requirements

- Node ≥ 20.11
- git, plus whatever the starter's `install` command needs (pnpm for `web`/`ui`, a JDK 25 for `java`)

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the contribution workflow and [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) for community guidelines. To report a vulnerability, see [SECURITY.md](.github/SECURITY.md).

## License

This project is licensed under [MIT](LICENSE).
