# starter-generator

Generate new applications from manifest-driven starter templates.

```bash
starter-generator virement-web
```

The generator itself knows nothing about any specific starter: each starter repository **describes itself** through a `generator.config.json` manifest and `.generator/templates/` scaffold files. The generator is a generic engine that fetches a starter, applies its manifest, and bootstraps the result (git, install, first commit). Adding a new starter (e.g. a Java API starter) means adding a manifest to that repository and one line to the registry — no engine changes.

## Registered starters

| Id     | Starter                                                                   | Generates                                      |
| ------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| `web`  | [angular-starter-web](https://github.com/JoanRoucoux/angular-starter-web) | An Angular web application                     |
| `ui`   | [angular-starter-ui](https://github.com/JoanRoucoux/angular-starter-ui)   | An Angular design system (library + Storybook) |
| `java` | [java-starter-api](https://github.com/JoanRoucoux/java-starter-api)       | A Spring Boot API in hexagonal architecture    |

## Usage

```bash
starter-generator [directory] [options]
```

| Option                   | Description                                                               |
| ------------------------ | ------------------------------------------------------------------------- |
| `--starter <id>`         | Starter from the registry (prompted if omitted)                           |
| `--template <repo\|dir>` | Template git URL or local directory (overrides `--starter`)               |
| `--ref <branch\|tag>`    | Git ref to clone from the template repository                             |
| `--name <kebab-case>`    | Application name (default: directory name without `-web`)                 |
| `--title <text>`         | Display title, used in the generated app's UI and README                  |
| `--feature <kebab-case>` | Initial feature name (default: application name)                          |
| `--openapi <path\|url>`  | OpenAPI spec copied into the starter's declared `openapiTarget`           |
| `--base-package <pkg>`   | Base package (e.g. `com.acme.payments`), for starters that prompt for one |
| `--skip-install`         | Do not run the starter's install command                                  |
| `--skip-git`             | Do not initialize a git repository                                        |
| `--yes` / `-y`           | Non-interactive: accept defaults for anything not provided as a flag      |

### Examples

```bash
# Interactive (prompts for starter, name, title, feature, OpenAPI spec)
starter-generator

# Fully scripted
starter-generator portfolio-web --starter web --name portfolio --title "Portfolio" \
  --openapi ../specs/portfolio-api.yaml --yes

# Spring Boot API backing that frontend, same OpenAPI contract
starter-generator portfolio-api --starter java --base-package com.acme.portfolio \
  --openapi ../specs/portfolio-api.yaml --yes

# From an internal mirror, or a local checkout (offline / testing starter changes)
starter-generator virement-web --template git@git.internal.bank:frontend/angular-starter-web.git
starter-generator virement-web --template ../angular-starter-web
```

Without publishing to a registry, run it directly: `node starter-generator/index.mjs virement-web`.

## How a generation works

1. **Fetch** — `git clone --depth 1` of the starter repository, or a filtered copy when `--template` points to a local directory (`copyIgnore`).
2. **Validate** — the starter must contain a `generator.config.json` with a supported `schema`; clear error otherwise.
3. **Ask** — name and title always; the feature and base-package prompts only if the starter lists them in `prompts`; the OpenAPI prompt only if it declares an `openapiTarget`.
4. **Apply the manifest, in order** — `remove` → `rename` → `jsonPatch` → `replace` → `replaceAll` → render `.generator/templates/` (overwriting existing files) → copy the `--openapi` spec to `openapiTarget` → delete `generator.config.json` and `.generator/` from the result.
5. **Bootstrap** — `git init -b main`, the starter's `install` command, its `postInstall` commands, then an initial commit (`--no-verify`: the project is freshly formatted, hooks apply from the first human commit).

## Manifest specification (`generator.config.json`, schema 1)

Everything is optional except `schema`. All string values in `rename`, `jsonPatch.set`, `replace.value`, `replaceAll.value` and `nextSteps` support `{{token}}` substitution.

```jsonc
{
  "schema": 1, // manifest schema version (required)
  "starter": "angular-starter-web", // display name, used in the bootstrap commit message
  "nameSuffix": "-web", // stripped from the directory name to derive the default app name
  "prompts": ["feature"], // extra prompts this starter needs ("feature" and "basePackage" exist today)
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
  "nextSteps": ["pnpm start"], // extra lines in the final recap
}
```

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

Available tokens: `projectName` (directory name), `appName`, `title`, `starterVersion` (from the template's package.json, when present) — plus, when the starter prompts for a feature: `feature`, `featurePascal`, `featureCamel`, `featureConst` (SNAKE_UPPER) — plus, when it prompts for a base package: `basePackage` (`com.acme.payments`) and `basePackagePath` (`com/acme/payments`; token values may contain `/`, so a single `__basePackagePath__` path segment expands to a nested directory).

Because template files contain tokens, they are not valid syntax: the starter must exclude `.generator/templates/` from its own formatters/linters (see the starter's `.prettierignore` and ESLint `globalIgnores`).

## Adding a starter

1. In the starter repository: add `generator.config.json` (see specification) and, if needed, `.generator/templates/`.
2. Here: add one entry to `REGISTRY` in [index.mjs](index.mjs).

## Updating generated apps

Generation is one-shot: each application lives its own life afterwards. To pick up starter improvements, follow the starter's changelog and apply the relevant changes manually.

## Requirements

- Node ≥ 20.11
- git, plus whatever the starter's `install` command needs (pnpm for `web`/`ui`, a JDK 21 for `java`)

## Contributing

See [CONTRIBUTING.md](.github/CONTRIBUTING.md) for the contribution workflow and [CODE_OF_CONDUCT.md](.github/CODE_OF_CONDUCT.md) for community guidelines. To report a vulnerability, see [SECURITY.md](.github/SECURITY.md).

## License

This project is licensed under [MIT](LICENSE).
