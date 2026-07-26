#!/usr/bin/env node
/**
 * starter-generator
 *
 * Generates a new application from a manifest-driven starter template.
 * The generator itself knows nothing about any specific starter: each starter
 * repository describes itself through a `generator.config.json` manifest
 * (files to remove, renames, JSON patches, optional modules, which prompts it needs) and
 * `.generator/templates/` scaffold files rendered with `{{token}}` placeholders.
 *
 * Two modes:
 *
 *   Generate (default) —
 *   1. Pick a starter from the built-in registry (or --template <url|dir>).
 *   2. Fetch it (git clone, or copy of a local directory) and read its manifest.
 *   3. Ask the questions the starter declares (name, title, feature, modules, OpenAPI spec).
 *   4. Apply the manifest: remove -> rename -> jsonPatch -> replace -> replaceAll -> render
 *      templates -> resolve module markers. Optional modules the user left out contribute their
 *      own `whenAbsent` removals to the first step and their own scaffolds to the sixth.
 *   5. Write a small `.starter-manifest.json` recording the template, tokens and modules chosen,
 *      install dependencies and create the first git commit.
 *
 *   Add modules (--add-modules) —
 *   Adds optional modules to an application generated earlier. Re-fetches the starter fresh, then
 *   generates two throwaway reference trees with the SAME identity — one with the application's
 *   current modules, one with those plus the new ones — and applies exactly the difference to
 *   the real application: new files/directories are copied in; shared files (poms, YAML, docs)
 *   that only gained an inserted block are patched in place; anything this can't do safely
 *   (a shared file whose surrounding content also changed, not just gained an insertion) is
 *   listed for a manual look rather than guessed at. Never touches git or runs an install.
 *
 * Usage:
 *   starter-generator [directory] [options]
 *
 * Options:
 *   --starter <id>          Starter from the registry (e.g. "web", "ui", "java")
 *   --template <repo|dir>   Template git URL or local directory (overrides --starter)
 *   --ref <branch|tag>      Git ref to clone from the template repository
 *   --name <kebab-case>     Application name (default: directory name without the starter's suffix)
 *   --title <text>          Display title, used in the generated app's UI and README
 *   --feature <kebab-case>  Initial feature name, for starters that scaffold one
 *   --openapi <path|url>    OpenAPI spec, for starters that declare an openapiTarget
 *   --base-package <pkg>    Base package (e.g. com.acme.payments), for starters that prompt for one
 *   --modules <a,b>         Optional modules to include, for starters that declare some ("" for none)
 *   --skip-install          Do not run the starter's install command
 *   --skip-git              Do not initialize a git repository
 *   --yes                   Non-interactive: accept defaults for unanswered options
 *   --add-modules <a,b>     Add modules to the application at [directory] (generated earlier by
 *                           this tool); ignores every other generation option
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exit, stdin } from 'node:process';
import { parseArgs } from 'node:util';

import * as p from '@clack/prompts';
import pc from 'picocolors';

// --- Registry of known starters ----------------------------------------------

const REGISTRY = {
  web: {
    label: 'Angular web application (angular-starter-web)',
    template: 'https://github.com/JoanRoucoux/angular-starter-web.git',
  },
  ui: {
    label: 'Angular design system (angular-starter-ui)',
    template: 'https://github.com/JoanRoucoux/angular-starter-ui.git',
  },
  java: {
    label: 'Spring Boot backend, hexagonal architecture (java-starter)',
    template: 'https://github.com/JoanRoucoux/java-starter.git',
  },
};

const MANIFEST_FILE = 'generator.config.json';
const TEMPLATES_DIR = '.generator';
// Left behind in every generated app (never deleted): the small state `--add-modules` needs
// later to know what it's building on top of. Unlike generator.config.json/.generator, which
// describe the STARTER, this describes the GENERATION — so it belongs in the result.
const STATE_FILE = '.starter-manifest.json';
const SUPPORTED_SCHEMA = 1;
const KEBAB_CASE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const JAVA_PACKAGE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9_]*)+$/;
// Template files with these extensions are copied as-is, without token substitution.
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.ttf', '.eot']);

// --- Helpers -----------------------------------------------------------------

const toPascalCase = (kebab) =>
  kebab
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

const toCamelCase = (kebab) => {
  const pascal = toPascalCase(kebab);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
};

const toTitle = (kebab) => {
  const words = kebab.split('-').join(' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const fail = (message) => {
  p.log.error(message);
  exit(1);
};

const checkCancel = (value) => {
  if (p.isCancel(value)) {
    p.cancel('Generation cancelled.');
    exit(1);
  }
  return value;
};

// git commands carry user-provided values (paths, refs): run them without a shell.
const runGit = (gitArgs, cwd) => spawnSync('git', gitArgs, { cwd, stdio: 'pipe', encoding: 'utf8' });
// Manifest commands are trusted shell strings from the starter (whose code we run anyway).
const runCommand = (command, cwd) => spawnSync(command, { cwd, stdio: 'inherit', shell: true });

// A manifest command is either a string or an object keyed by process.platform with a
// `default` fallback (e.g. {"default": "./mvnw ...", "win32": "mvnw.cmd ..."}).
const resolveCommand = (command) =>
  typeof command === 'string' ? command : (command[process.platform] ?? command.default);

/** Replaces every `{{token}}` in `text`; warns once per unknown token. */
const substituteTokens = (text, tokens, context) =>
  text.replace(/\{\{([a-zA-Z]+)\}\}/g, (match, name) => {
    if (tokens[name] === undefined) {
      p.log.warn(`Unknown token ${match} in ${context} — left as-is.`);
      return match;
    }
    return tokens[name];
  });

/** Replaces every `__token__` in a relative path; unknown tokens are fatal. */
const substitutePathTokens = (relativePath, tokens) =>
  relativePath.replace(/__([a-zA-Z]+)__/g, (match, name) => {
    if (tokens[name] === undefined) fail(`Unknown path token ${match} in template path ${relativePath}.`);
    return tokens[name];
  });

const readManifest = (root, templateLabel) => {
  const manifestPath = path.join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { error: `${templateLabel} is not a generator-enabled starter: it has no ${MANIFEST_FILE}.` };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    return { error: `Invalid ${MANIFEST_FILE} in ${templateLabel}: ${cause.message}` };
  }
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    return {
      error: `${MANIFEST_FILE} declares schema ${manifest.schema}, this generator supports schema ${SUPPORTED_SCHEMA}. Update the generator.`,
    };
  }
  return { manifest };
};

/** Required modules are informational (never removable); optional ones the caller has chosen. */
const deriveModuleSets = (manifest, selectedModules) => {
  const requiredModules = manifest.modules?.required ?? [];
  const optionalModules = manifest.modules?.optional ?? [];
  const absentModules = optionalModules.filter((module) => !selectedModules.has(module.id));
  const includedModules = [
    ...requiredModules,
    ...optionalModules.filter((module) => selectedModules.has(module.id)).map((module) => module.id),
  ];
  return { requiredModules, optionalModules, absentModules, includedModules };
};

// Tree-wide literal replacement, for identities that appear in many files (Maven artifactIds,
// Java package/import statements). Binary files, .git, the manifest and the scaffold templates
// (whose {{tokens}} must survive until render) are never touched.
const collectReplaceAllFiles = (dir, files = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === TEMPLATES_DIR || entry === MANIFEST_FILE || entry === STATE_FILE) continue;
    const entryPath = path.join(dir, entry);
    if (statSync(entryPath).isDirectory()) {
      collectReplaceAllFiles(entryPath, files);
    } else if (!BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
};

/** Every file under `dir`, as paths relative to it (posix separators). Used by --add-modules to
 * diff two generated trees; unlike collectReplaceAllFiles this includes binary files. */
const collectAllFiles = (dir, root = dir, files = []) => {
  for (const entry of readdirSync(dir)) {
    const entryPath = path.join(dir, entry);
    if (statSync(entryPath).isDirectory()) {
      collectAllFiles(entryPath, root, files);
    } else {
      files.push(path.relative(root, entryPath).replaceAll(path.sep, '/'));
    }
  }
  return files;
};

/**
 * Applies a starter's manifest (minus the questions, which the caller has already answered into
 * `tokens`/`selectedModules`) to `targetDir`: remove -> rename -> jsonPatch -> replace ->
 * replaceAll -> render templates -> resolve module markers -> wire the OpenAPI spec -> delete the
 * manifest and templates (they describe the starter, not the result). Shared by real generation
 * and by --add-modules's two throwaway reference trees.
 */
const applyManifest = ({ targetDir, manifest, tokens, selectedModules, openapi }) => {
  const { optionalModules, absentModules, includedModules } = deriveModuleSets(manifest, selectedModules);
  // Any manifest entry may carry a `module` field: it then applies only when that module made it
  // into the generated application. Without one, the entry always applies.
  const appliesHere = (entry) => !entry.module || includedModules.includes(entry.module);

  // Both lists use literal repository paths: they run before `rename` renames anything.
  for (const relative of [...(manifest.remove ?? []), ...absentModules.flatMap((m) => m.whenAbsent?.remove ?? [])]) {
    rmSync(path.join(targetDir, relative), { recursive: true, force: true });
  }

  // Renames apply sequentially: each `from` sees the tree as left by the previous entries.
  // Both sides are token-substituted, so module directories and package roots can take the
  // application's name (`remove` above intentionally still uses literal repository paths).
  for (const rename of manifest.rename ?? []) {
    if (!appliesHere(rename)) continue;
    const context = `${MANIFEST_FILE} rename`;
    const from = substituteTokens(rename.from, tokens, context);
    const to = substituteTokens(rename.to, tokens, context);
    if (from === to) continue;
    const fromPath = path.join(targetDir, from);
    const toPath = path.join(targetDir, to);
    if (!existsSync(fromPath)) {
      p.log.warn(`rename source not found: ${from} — template drift?`);
      continue;
    }
    if (existsSync(toPath)) {
      p.log.warn(`rename target already exists: ${to} — template drift?`);
      continue;
    }
    mkdirSync(path.dirname(toPath), { recursive: true });
    renameSync(fromPath, toPath);
    // Prune directories the move left empty (e.g. com/example/ after a package root rename).
    for (let parent = path.dirname(fromPath); parent !== targetDir; parent = path.dirname(parent)) {
      if (!existsSync(parent) || readdirSync(parent).length > 0) break;
      rmSync(parent, { recursive: true });
    }
  }

  const substituteDeep = (value, context) => {
    if (typeof value === 'string') return substituteTokens(value, tokens, context);
    if (Array.isArray(value)) return value.map((item) => substituteDeep(item, context));
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteDeep(item, context)]));
    }
    return value;
  };

  // From here on, every path is token-substituted: `rename` above has already moved the tree.
  for (const patch of manifest.jsonPatch ?? []) {
    if (!appliesHere(patch)) continue;
    const file = substituteTokens(patch.file, tokens, `${MANIFEST_FILE} jsonPatch`);
    const filePath = path.join(targetDir, file);
    if (!existsSync(filePath)) {
      p.log.warn(`jsonPatch target not found: ${file} — template drift?`);
      continue;
    }
    const json = JSON.parse(readFileSync(filePath, 'utf8'));
    Object.assign(json, substituteDeep(patch.set ?? {}, `${MANIFEST_FILE} jsonPatch (${file})`));
    for (const key of patch.delete ?? []) delete json[key];
    writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
  }

  for (const replacement of manifest.replace ?? []) {
    if (!appliesHere(replacement)) continue;
    const context = `${MANIFEST_FILE} replace`;
    const file = substituteTokens(replacement.file, tokens, context);
    const filePath = path.join(targetDir, file);
    if (!existsSync(filePath)) {
      if (!replacement.optional) p.log.warn(`replace target not found: ${file} — template drift?`);
      continue;
    }
    const content = readFileSync(filePath, 'utf8');
    if (!content.includes(replacement.search)) {
      if (!replacement.optional) {
        p.log.warn(`Pattern not found in ${file}: ${JSON.stringify(replacement.search)} — template drift?`);
      }
      continue;
    }
    writeFileSync(
      filePath,
      content.replaceAll(replacement.search, substituteTokens(replacement.value, tokens, context)),
    );
  }

  if ((manifest.replaceAll ?? []).length > 0) {
    const files = collectReplaceAllFiles(targetDir);
    for (const replacement of manifest.replaceAll) {
      if (!appliesHere(replacement)) continue;
      const value = substituteTokens(replacement.value, tokens, `${MANIFEST_FILE} replaceAll`);
      let touched = 0;
      for (const filePath of files) {
        if (replacement.extensions && !replacement.extensions.includes(path.extname(filePath).toLowerCase())) {
          continue;
        }
        const content = readFileSync(filePath, 'utf8');
        if (!content.includes(replacement.search)) continue;
        writeFileSync(filePath, content.replaceAll(replacement.search, value));
        touched += 1;
      }
      if (touched === 0 && !replacement.optional) {
        p.log.warn(`replaceAll pattern not found anywhere: ${JSON.stringify(replacement.search)} — template drift?`);
      }
    }
  }

  // Render a scaffold tree over the target, overwriting existing files. `.generator/templates` is
  // always rendered; an absent module may declare a second tree of its own, so the variant
  // without it gets files that cannot be obtained by deletion alone.
  const renderTemplateTree = (root) => {
    const walk = (dir) => {
      for (const entry of readdirSync(dir)) {
        const sourcePath = path.join(dir, entry);
        if (statSync(sourcePath).isDirectory()) {
          walk(sourcePath);
          continue;
        }
        const relative = path.relative(root, sourcePath).replaceAll(path.sep, '/');
        const outputPath = path.join(targetDir, substitutePathTokens(relative, tokens));
        mkdirSync(path.dirname(outputPath), { recursive: true });
        if (BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
          cpSync(sourcePath, outputPath);
        } else {
          writeFileSync(outputPath, substituteTokens(readFileSync(sourcePath, 'utf8'), tokens, `template ${relative}`));
        }
      }
    };
    if (existsSync(root)) {
      walk(root);
      return true;
    }
    return false;
  };
  renderTemplateTree(path.join(targetDir, TEMPLATES_DIR, 'templates'));
  for (const module of absentModules) {
    const extraTemplates = module.whenAbsent?.templates;
    if (!extraTemplates) continue;
    if (!renderTemplateTree(path.join(targetDir, TEMPLATES_DIR, extraTemplates))) {
      p.log.warn(`whenAbsent templates not found: ${TEMPLATES_DIR}/${extraTemplates} — template drift?`);
    }
  }

  // An optional module frames the parts of shared files (poms, YAML, docs) that belong to it with
  // a pair of markers, each alone on its line. Left out, the whole span goes; kept, only the two
  // marker lines go — a generated application never ships a generator comment either way. Runs
  // after the templates, so their own marked sections are handled too.
  const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const LINE_SPACE = '[^\\S\\r\\n]*';
  const markerPattern = (marker, present) =>
    new RegExp(
      present
        ? `^${LINE_SPACE}(?:${escapeRegExp(marker.start)}|${escapeRegExp(marker.end)})${LINE_SPACE}(?:\\r?\\n|$)`
        : `^${LINE_SPACE}${escapeRegExp(marker.start)}${LINE_SPACE}\\r?\\n[\\s\\S]*?^${LINE_SPACE}${escapeRegExp(marker.end)}${LINE_SPACE}(?:\\r?\\n|$)`,
      'gm',
    );
  const markers = optionalModules.flatMap((module) =>
    (module.markers ?? []).map((marker) => ({ marker, present: selectedModules.has(module.id) })),
  );
  if (markers.length > 0) {
    const files = collectReplaceAllFiles(targetDir);
    for (const { marker, present } of markers) {
      const pattern = markerPattern(marker, present);
      let touched = 0;
      for (const filePath of files) {
        if (marker.extensions && !marker.extensions.includes(path.extname(filePath).toLowerCase())) continue;
        const content = readFileSync(filePath, 'utf8');
        const updated = content.replace(pattern, '');
        if (updated === content) continue;
        writeFileSync(filePath, updated);
        touched += 1;
      }
      if (touched === 0 && !marker.optional) {
        p.log.warn(`markers not found anywhere: ${marker.start} … ${marker.end} — template drift?`);
      }
    }
  }

  // Wire the provided OpenAPI spec, if any.
  if (openapi) {
    const openapiTarget = path.join(
      targetDir,
      substituteTokens(manifest.openapiTarget, tokens, `${MANIFEST_FILE} openapiTarget`),
    );
    mkdirSync(path.dirname(openapiTarget), { recursive: true });
    if (/^https?:\/\//.test(openapi)) {
      // Resolved by the caller (fetch is async); see wireOpenapi below for the real generate flow.
    } else {
      const openapiSource = path.resolve(openapi);
      if (!existsSync(openapiSource)) fail(`OpenAPI spec not found: ${openapiSource}`);
      cpSync(openapiSource, openapiTarget);
    }
  }

  // The manifest and templates describe the starter, not the generated app.
  rmSync(path.join(targetDir, MANIFEST_FILE), { force: true });
  rmSync(path.join(targetDir, TEMPLATES_DIR), { recursive: true, force: true });
};

/** Fetches a remote OpenAPI spec — kept separate from applyManifest because it is the only
 * async step in an otherwise synchronous pipeline. No-op for a local path (applyManifest copies
 * it directly) or when there is nothing to fetch. */
const wireRemoteOpenapi = async (targetDir, manifest, tokens, openapi) => {
  if (!openapi || !/^https?:\/\//.test(openapi)) return;
  const openapiTarget = path.join(
    targetDir,
    substituteTokens(manifest.openapiTarget, tokens, `${MANIFEST_FILE} openapiTarget`),
  );
  const response = await fetch(openapi);
  if (!response.ok) fail(`Failed to download OpenAPI spec: HTTP ${response.status} for ${openapi}`);
  mkdirSync(path.dirname(openapiTarget), { recursive: true });
  writeFileSync(openapiTarget, await response.text());
};

// --- Line diffing, for --add-modules -----------------------------------------

/** A minimal LCS-based line diff: the ops that turn `baseLines` into `targetLines`. */
const diffLines = (baseLines, targetLines) => {
  const n = baseLines.length;
  const m = targetLines.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = baseLines[i] === targetLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (baseLines[i] === targetLines[j] && dp[i][j] === dp[i + 1][j + 1] + 1) {
      ops.push({ type: 'context', line: baseLines[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'remove', line: baseLines[i] });
      i += 1;
    } else {
      ops.push({ type: 'add', line: targetLines[j] });
      j += 1;
    }
  }
  while (i < n) {
    ops.push({ type: 'remove', line: baseLines[i] });
    i += 1;
  }
  while (j < m) {
    ops.push({ type: 'add', line: targetLines[j] });
    j += 1;
  }
  return ops;
};

const isPureInsertion = (ops) => !ops.some((op) => op.type === 'remove');

// A single preceding line ("    </dependency>", "") repeats constantly in formatted XML/YAML —
// anchoring on one line alone would frequently match nowhere near the real insertion point. A
// short window of consecutive lines is unique in practice (it only takes one distinctive line —
// an artifactId, a property name — inside the window).
const ANCHOR_WINDOW = 3;

/** Groups consecutive `add` ops into hunks anchored on the (up to) last `ANCHOR_WINDOW` `context`
 * lines before them (an empty anchor means "insert at the very top"). Only meaningful for a
 * pure-insertion diff. */
const insertionHunks = (ops) => {
  const hunks = [];
  let contextWindow = [];
  let pending = [];
  for (const op of ops) {
    if (op.type === 'context') {
      if (pending.length > 0) {
        hunks.push({ anchor: contextWindow.slice(-ANCHOR_WINDOW), lines: pending });
        pending = [];
      }
      contextWindow.push(op.line);
    } else if (op.type === 'add') {
      pending.push(op.line);
    }
  }
  if (pending.length > 0) hunks.push({ anchor: contextWindow.slice(-ANCHOR_WINDOW), lines: pending });
  return hunks;
};

/** Splices a hunk into `targetLines` right after its anchor sequence — found by exact,
 * contiguous match, which must be unique (an anchor seen twice, or not at all, is reported
 * unapplied rather than guessed). */
const applyHunk = (targetLines, hunk) => {
  const { anchor, lines } = hunk;
  if (anchor.length === 0) {
    return { lines: [...lines, ...targetLines], applied: true };
  }
  const matches = [];
  for (let end = anchor.length - 1; end < targetLines.length; end++) {
    const start = end - anchor.length + 1;
    if (anchor.every((line, offset) => targetLines[start + offset] === line)) matches.push(end);
  }
  if (matches.length !== 1) return { lines: targetLines, applied: false };
  const insertAt = matches[0] + 1;
  return {
    lines: [...targetLines.slice(0, insertAt), ...lines, ...targetLines.slice(insertAt)],
    applied: true,
  };
};

const formatDiffPreview = (ops, maxLines = 12) => {
  const changed = ops.filter((op) => op.type !== 'context');
  const preview = changed.slice(0, maxLines).map((op) => `  ${op.type === 'add' ? '+' : '-'} ${op.line}`);
  const more = changed.length > maxLines ? [`  … ${changed.length - maxLines} more line(s)`] : [];
  return [...preview, ...more].join('\n');
};

// --- 1. Arguments ------------------------------------------------------------

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    starter: { type: 'string' },
    template: { type: 'string' },
    ref: { type: 'string' },
    name: { type: 'string' },
    title: { type: 'string' },
    feature: { type: 'string' },
    openapi: { type: 'string' },
    'base-package': { type: 'string' },
    modules: { type: 'string' },
    'skip-install': { type: 'boolean', default: false },
    'skip-git': { type: 'boolean', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    'add-modules': { type: 'string' },
  },
});

if (args.help) {
  const header = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0];
  console.log(header.replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  exit(0);
}

const interactive = stdin.isTTY && !args.yes;

// --- Generate: pick a starter, fetch it, ask questions, apply, bootstrap -----

async function runGenerate() {
  p.intro(pc.bgCyan(pc.black(' starter-generator ')));

  let template = args.template;
  if (!template) {
    let starterId = args.starter;
    if (starterId && !REGISTRY[starterId]) {
      fail(`Unknown starter "${starterId}". Available: ${Object.keys(REGISTRY).join(', ')}.`);
    }
    if (!starterId) {
      if (interactive) {
        starterId = checkCancel(
          await p.select({
            message: 'Which starter?',
            options: Object.entries(REGISTRY).map(([value, { label }]) => ({ value, label })),
          }),
        );
      } else {
        starterId = Object.keys(REGISTRY)[0];
        p.log.info(`No starter specified: defaulting to "${starterId}".`);
      }
    }
    template = REGISTRY[starterId].template;
  }
  const localTemplate = existsSync(path.resolve(template)) ? path.resolve(template) : undefined;

  let directory = positionals[0];
  if (!directory) {
    if (!interactive) fail('A target directory is required in non-interactive mode.');
    directory = checkCancel(
      await p.text({
        message: 'Where should the application be created?',
        placeholder: './virement-web',
        validate: (value) => (value.trim() === '' ? 'A directory is required.' : undefined),
      }),
    );
  }
  const targetDir = path.resolve(directory);
  const projectName = path.basename(targetDir);
  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    fail(`Directory ${targetDir} already exists and is not empty.`);
  }

  const spinner = p.spinner();
  let manifest;

  if (localTemplate) {
    // Read the manifest from the source so copyIgnore applies to the copy itself.
    const { manifest: sourceManifest, error } = readManifest(localTemplate, template);
    if (error) fail(error);
    manifest = sourceManifest;
    const copyIgnore = ['.git', ...(manifest.copyIgnore ?? [])];

    spinner.start(`Copying template from ${localTemplate}`);
    cpSync(localTemplate, targetDir, {
      recursive: true,
      filter: (src) => {
        const relative = path.relative(localTemplate, src).replaceAll(path.sep, '/');
        return !copyIgnore.some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`));
      },
    });
    spinner.stop('Template copied.');
  } else {
    spinner.start(`Cloning template from ${template}`);
    const clone = runGit(['clone', '--depth', '1', ...(args.ref ? ['--branch', args.ref] : []), template, targetDir]);
    if (clone.status !== 0) {
      spinner.stop('Clone failed.', 1);
      rmSync(targetDir, { recursive: true, force: true });
      fail(`git clone failed:\n${clone.stderr}`);
    }
    rmSync(path.join(targetDir, '.git'), { recursive: true, force: true });
    spinner.stop('Template cloned.');

    const { manifest: clonedManifest, error } = readManifest(targetDir, template);
    if (error) {
      rmSync(targetDir, { recursive: true, force: true });
      fail(error);
    }
    manifest = clonedManifest;
  }

  const starterName = manifest.starter ?? path.basename(template, '.git');
  const prompts = manifest.prompts ?? [];
  const templatePackageJsonPath = path.join(targetDir, 'package.json');
  const starterVersion = existsSync(templatePackageJsonPath)
    ? (JSON.parse(readFileSync(templatePackageJsonPath, 'utf8')).version ?? '')
    : '';

  // --- Answers (flags first, prompts the starter declares for the rest) -----

  const defaultName =
    manifest.nameSuffix && projectName.endsWith(manifest.nameSuffix)
      ? projectName.slice(0, -manifest.nameSuffix.length)
      : projectName;

  let appName = args.name ?? defaultName;
  if (interactive && !args.name) {
    appName = checkCancel(
      await p.text({
        message: 'Application name (kebab-case)?',
        initialValue: appName,
        validate: (value) =>
          KEBAB_CASE.test(value) ? undefined : 'Use kebab-case: lowercase letters, digits, dashes.',
      }),
    );
  }
  if (!KEBAB_CASE.test(appName)) fail(`Invalid application name "${appName}": use kebab-case.`);

  let title = args.title ?? toTitle(appName);
  if (interactive && !args.title) {
    title = checkCancel(
      await p.text({
        message: 'Display title?',
        initialValue: title,
        validate: (value) => (value.trim() === '' ? 'A title is required.' : undefined),
      }),
    );
  }

  let feature = args.feature;
  if (prompts.includes('feature')) {
    feature ??= appName;
    if (interactive && !args.feature) {
      feature = checkCancel(
        await p.text({
          message: 'Initial feature name (kebab-case)?',
          initialValue: feature,
          validate: (value) =>
            KEBAB_CASE.test(value) ? undefined : 'Use kebab-case: lowercase letters, digits, dashes.',
        }),
      );
    }
  }
  if (feature !== undefined && !KEBAB_CASE.test(feature)) {
    fail(`Invalid feature name "${feature}": use kebab-case.`);
  }

  let basePackage = args['base-package'];
  if (prompts.includes('basePackage')) {
    basePackage ??= `com.example.${appName.replaceAll('-', '')}`;
    if (interactive && !args['base-package']) {
      basePackage = checkCancel(
        await p.text({
          message: 'Base package (e.g. com.acme.payments)?',
          initialValue: basePackage,
          validate: (value) =>
            JAVA_PACKAGE.test(value) ? undefined : 'Use a dotted lowercase package: at least two segments.',
        }),
      );
    }
  }
  if (basePackage !== undefined && !JAVA_PACKAGE.test(basePackage)) {
    fail(`Invalid base package "${basePackage}": use a dotted lowercase package (e.g. com.acme.payments).`);
  }

  // Optional modules: the starter declares which parts of itself can be left out, and what to
  // remove when they are. Required modules are informational — they are never removable.
  const { requiredModules, optionalModules } = deriveModuleSets(manifest, new Set());
  let selectedModules = new Set();
  if (optionalModules.length > 0) {
    const known = new Set(optionalModules.map((module) => module.id));
    if (args.modules !== undefined) {
      const requested = args.modules
        .split(',')
        .map((id) => id.trim())
        .filter(Boolean);
      for (const id of requested) {
        if (!known.has(id)) fail(`Unknown module "${id}". This starter offers: ${[...known].join(', ')}.`);
      }
      selectedModules = new Set(requested);
    } else if (interactive) {
      selectedModules = new Set(
        checkCancel(
          await p.multiselect({
            message: `Optional modules? (${requiredModules.join(', ')} ${requiredModules.length > 1 ? 'are' : 'is'} always included)`,
            options: optionalModules.map((module) => ({
              value: module.id,
              label: module.label ?? module.id,
              hint: module.hint,
            })),
            initialValues: optionalModules.filter((module) => module.default).map((module) => module.id),
            required: false,
          }),
        ),
      );
    } else {
      selectedModules = new Set(optionalModules.filter((module) => module.default).map((module) => module.id));
    }
    // Dependencies between optional modules are declared by the starter, never inferred here.
    for (const module of optionalModules) {
      if (!selectedModules.has(module.id)) continue;
      for (const dependency of module.requires ?? []) {
        if (!selectedModules.has(dependency)) {
          fail(`Module "${module.id}" requires "${dependency}": include it, or leave "${module.id}" out.`);
        }
      }
    }
  } else if (args.modules !== undefined) {
    p.log.warn(`This starter declares no optional modules in ${MANIFEST_FILE}: --modules ignored.`);
  }
  const { includedModules } = deriveModuleSets(manifest, selectedModules);

  let openapi = args.openapi;
  if (manifest.openapiTarget) {
    if (interactive && openapi === undefined) {
      const answer = checkCancel(
        await p.text({
          message: 'OpenAPI spec to use (path or URL, leave empty to keep the placeholder)?',
          defaultValue: '',
        }),
      );
      openapi = answer.trim() === '' ? undefined : answer.trim();
    }
  } else if (openapi) {
    p.log.warn(`This starter declares no openapiTarget in ${MANIFEST_FILE}: --openapi ignored.`);
    openapi = undefined;
  }

  let install = !args['skip-install'] && Boolean(manifest.install);
  if (interactive && install) {
    install = checkCancel(await p.confirm({ message: 'Install dependencies?', initialValue: true }));
  }

  // --- Tokens ---------------------------------------------------------------

  const tokens = {
    projectName,
    appName,
    title,
    starterVersion,
    ...(feature !== undefined && {
      feature,
      featurePascal: toPascalCase(feature),
      featureCamel: toCamelCase(feature),
      featureConst: feature.replaceAll('-', '_').toUpperCase(),
    }),
    ...(basePackage !== undefined && {
      basePackage,
      basePackagePath: basePackage.replaceAll('.', '/'),
    }),
    ...(includedModules.length > 0 && { modules: includedModules.join(', ') }),
  };

  // --- Apply the manifest ---------------------------------------------------

  spinner.start('Applying the starter manifest');
  applyManifest({ targetDir, manifest, tokens, selectedModules, openapi });
  await wireRemoteOpenapi(targetDir, manifest, tokens, openapi);
  spinner.stop('Starter manifest applied.');

  // What this generation was, for a future --add-modules to build on.
  writeFileSync(
    path.join(targetDir, STATE_FILE),
    `${JSON.stringify(
      {
        starter: starterName,
        // Resolved to an absolute path for a local template dir, so --add-modules finds it again
        // regardless of the working directory it's run from later.
        template: localTemplate ?? template,
        ref: args.ref ?? null,
        modules: includedModules,
        tokens: {
          appName,
          title,
          ...(feature !== undefined && { feature }),
          ...(basePackage !== undefined && { basePackage }),
        },
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  // --- git init, install, first commit --------------------------------------

  if (!args['skip-git']) {
    spinner.start('Initializing git repository');
    const init = runGit(['init', '-b', 'main'], targetDir);
    spinner.stop(init.status === 0 ? 'Git repository initialized.' : 'git init failed (skipped).');
  }

  let installOk = false;
  const installCommand = manifest.install ? resolveCommand(manifest.install) : undefined;
  if (install) {
    p.log.step(`Installing dependencies (${installCommand})...`);
    installOk = runCommand(installCommand, targetDir).status === 0;
    if (installOk) {
      for (const command of manifest.postInstall ?? []) {
        const resolved = resolveCommand(command);
        p.log.step(`Running ${resolved}...`);
        runCommand(resolved, targetDir);
      }
    } else {
      p.log.warn(`${installCommand} failed — run it manually.`);
    }
  }

  if (!args['skip-git']) {
    spinner.start('Creating the initial commit');
    runGit(['add', '-A'], targetDir);
    // The commit is machine-generated and the project freshly formatted:
    // hooks (lint-staged, commitlint) kick in from the first human commit.
    const versionSuffix = starterVersion ? ` v${starterVersion}` : '';
    const commit = runGit(
      ['commit', '--no-verify', '-m', `chore: bootstrap ${projectName} from ${starterName}${versionSuffix}`],
      targetDir,
    );
    spinner.stop(commit.status === 0 ? 'Initial commit created.' : 'Initial commit failed (skipped).');
  }

  // --- Recap -----------------------------------------------------------------

  const appliesHere = (entry) => !entry.module || includedModules.includes(entry.module);
  const nextSteps = [
    `cd ${path.relative(process.cwd(), targetDir) || '.'}`,
    ...(installOk || !installCommand ? [] : [installCommand]),
    // A step can be tied to a module: `{ "module": "schema", "text": "..." }` shows only when that
    // module made it into the generated application.
    ...(manifest.nextSteps ?? [])
      .filter((step) => typeof step === 'string' || appliesHere(step))
      .map((step) =>
        substituteTokens(typeof step === 'string' ? step : step.text, tokens, `${MANIFEST_FILE} nextSteps`),
      ),
  ];
  p.note(nextSteps.join('\n'), 'Next steps');
  p.outro(`${pc.green('Done!')} ${title} is ready in ${pc.cyan(targetDir)}`);
}

// --- Add modules: extend an application generated earlier --------------------

async function runAddModules() {
  p.intro(pc.bgCyan(pc.black(' starter-generator: add modules ')));

  const directory = positionals[0];
  if (!directory) fail('A target directory is required with --add-modules.');
  const targetDir = path.resolve(directory);
  if (!existsSync(targetDir) || readdirSync(targetDir).length === 0) {
    fail(`${targetDir} does not look like a generated application (missing, or empty).`);
  }
  const statePath = path.join(targetDir, STATE_FILE);
  if (!existsSync(statePath)) {
    fail(
      `${targetDir} has no ${STATE_FILE}: it predates this feature, or wasn't generated by starter-generator. Modules can only be added to an application generated by a version of starter-generator that writes this file.`,
    );
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const existingModules = new Set(state.modules ?? []);

  const requestedIds = (args['add-modules'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (requestedIds.length === 0) fail('--add-modules requires at least one module id.');

  const spinner = p.spinner();
  spinner.start(`Fetching ${state.starter ?? state.template} to read its current manifest`);
  const scratchRoot = mkdtempSync(path.join(tmpdir(), 'starter-generator-add-'));
  const templateClone = path.join(scratchRoot, 'template');
  // `state.template` is either a git URL or an absolute local directory (runGenerate resolves it
  // before recording it) — same detection as the initial generation, so local-checkout workflows
  // ("offline / testing starter changes") keep working for --add-modules too.
  if (existsSync(state.template)) {
    // Read the manifest from the source so its own copyIgnore applies to the copy itself —
    // otherwise a local checkout's build output (target/, .idea/, …) rides along into both
    // reference trees and can surface as a bogus diff.
    const { manifest: sourceManifest, error: sourceError } = readManifest(state.template, state.template);
    if (sourceError) fail(sourceError);
    const copyIgnore = ['.git', ...(sourceManifest.copyIgnore ?? [])];
    cpSync(state.template, templateClone, {
      recursive: true,
      filter: (src) => {
        const relative = path.relative(state.template, src).replaceAll(path.sep, '/');
        return !copyIgnore.some((ignored) => relative === ignored || relative.startsWith(`${ignored}/`));
      },
    });
  } else {
    const clone = runGit(
      ['clone', '--depth', '1', ...(state.ref ? ['--branch', state.ref] : []), state.template, templateClone],
      undefined,
    );
    if (clone.status !== 0) {
      rmSync(scratchRoot, { recursive: true, force: true });
      spinner.stop('Fetch failed.', 1);
      fail(`git clone failed:\n${clone.stderr}`);
    }
    rmSync(path.join(templateClone, '.git'), { recursive: true, force: true });
  }
  spinner.stop('Fetched the current starter.');

  const { manifest, error } = readManifest(templateClone, state.template);
  if (error) fail(error);

  const optionalModules = manifest.modules?.optional ?? [];
  const known = new Set(optionalModules.map((module) => module.id));
  for (const id of requestedIds) {
    if (!known.has(id)) fail(`Unknown module "${id}". This starter offers: ${[...known].join(', ')}.`);
    if (existingModules.has(id)) fail(`Module "${id}" is already part of this application.`);
  }
  const finalModules = new Set([...existingModules, ...requestedIds]);
  for (const id of requestedIds) {
    const module = optionalModules.find((candidate) => candidate.id === id);
    for (const dependency of module.requires ?? []) {
      if (!finalModules.has(dependency)) {
        fail(`Module "${id}" requires "${dependency}": add it too (--add-modules ${dependency},${id}).`);
      }
    }
  }

  const baseTokens = {
    projectName: path.basename(targetDir),
    appName: state.tokens.appName,
    title: state.tokens.title,
    starterVersion: '',
    ...(state.tokens.feature !== undefined && {
      feature: state.tokens.feature,
      featurePascal: toPascalCase(state.tokens.feature),
      featureCamel: toCamelCase(state.tokens.feature),
      featureConst: state.tokens.feature.replaceAll('-', '_').toUpperCase(),
    }),
    ...(state.tokens.basePackage !== undefined && {
      basePackage: state.tokens.basePackage,
      basePackagePath: state.tokens.basePackage.replaceAll('.', '/'),
    }),
  };

  spinner.start("Regenerating two reference trees to isolate what's new");
  const before = path.join(scratchRoot, 'before');
  const after = path.join(scratchRoot, 'after');
  cpSync(templateClone, before, { recursive: true });
  cpSync(templateClone, after, { recursive: true });
  applyManifest({
    targetDir: before,
    manifest,
    tokens: { ...baseTokens, ...(existingModules.size > 0 && { modules: [...existingModules].join(', ') }) },
    selectedModules: existingModules,
  });
  applyManifest({
    targetDir: after,
    manifest,
    tokens: { ...baseTokens, modules: [...finalModules].join(', ') },
    selectedModules: finalModules,
  });
  spinner.stop('Reference trees ready.');

  const filesBefore = new Set(collectAllFiles(before));
  const filesAfter = collectAllFiles(after);

  const added = [];
  const patched = [];
  const skipped = [];
  const manual = [];

  for (const relative of filesAfter) {
    const targetPath = path.join(targetDir, relative);
    const afterPath = path.join(after, relative);
    const isBinary = BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase());

    if (!filesBefore.has(relative)) {
      // Entirely new — belongs to one of the modules just added.
      if (existsSync(targetPath)) {
        skipped.push(relative);
        continue;
      }
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(afterPath, targetPath);
      added.push(relative);
      continue;
    }

    if (isBinary) continue; // Present in both, binary: nothing sensible to diff or patch.

    const beforeContent = readFileSync(path.join(before, relative), 'utf8');
    const afterContent = readFileSync(afterPath, 'utf8');
    if (beforeContent === afterContent) continue; // Untouched by the new module(s).

    if (!existsSync(targetPath)) {
      manual.push({ file: relative, note: 'expected in the application but missing — added fresh', preview: null });
      mkdirSync(path.dirname(targetPath), { recursive: true });
      cpSync(afterPath, targetPath);
      continue;
    }

    const ops = diffLines(beforeContent.split('\n'), afterContent.split('\n'));
    if (!isPureInsertion(ops)) {
      // Something besides the new module also changed this file's surrounding content between
      // the two reference trees (typically a "with these modules: ..." summary line) — safer to
      // point it out than to guess where a patch belongs.
      manual.push({
        file: relative,
        note: "isn't a clean insertion — review and merge by hand",
        preview: formatDiffPreview(ops),
      });
      continue;
    }

    let targetLines = readFileSync(targetPath, 'utf8').split('\n');
    const leftover = [];
    for (const hunk of insertionHunks(ops)) {
      const result = applyHunk(targetLines, hunk);
      if (result.applied) {
        targetLines = result.lines;
      } else {
        leftover.push(hunk.lines.join('\n'));
      }
    }
    writeFileSync(targetPath, targetLines.join('\n'));
    if (leftover.length > 0) {
      manual.push({
        file: relative,
        note: 'anchor line not found (or not unique) — insert by hand',
        preview: leftover.map((snippet) => snippet.replaceAll(/^/gm, '  + ')).join('\n  ...\n'),
      });
    } else {
      patched.push(relative);
    }
  }

  rmSync(scratchRoot, { recursive: true, force: true });

  state.modules = [...finalModules].sort();
  state.lastModifiedAt = new Date().toISOString();
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  p.log.success(`Added module(s): ${requestedIds.join(', ')}.`);
  if (added.length > 0) p.log.info(`New files:\n${added.map((f) => `  ${f}`).join('\n')}`);
  if (patched.length > 0) p.log.info(`Patched in place:\n${patched.map((f) => `  ${f}`).join('\n')}`);
  if (skipped.length > 0) {
    p.log.warn(`Already present, left untouched:\n${skipped.map((f) => `  ${f}`).join('\n')}`);
  }
  if (manual.length > 0) {
    const details = manual
      .map(({ file, note, preview }) => `${file} — ${note}${preview ? `\n${preview}` : ''}`)
      .join('\n\n');
    p.log.warn(`Needs a manual look — this tool would rather flag it than guess wrong:\n\n${details}`);
  }
  p.outro(`${pc.green('Done.')} Review the changes (git diff), then format/build as usual.`);
}

if (args['add-modules'] !== undefined) {
  await runAddModules();
} else {
  await runGenerate();
}
