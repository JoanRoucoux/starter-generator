#!/usr/bin/env node
/**
 * starter-generator
 *
 * Generates a new application from a manifest-driven starter template.
 * The generator itself knows nothing about any specific starter: each starter
 * repository describes itself through a `generator.config.json` manifest
 * (files to remove, renames, JSON patches, which prompts it needs) and
 * `.generator/templates/` scaffold files rendered with `{{token}}` placeholders.
 *
 * Flow:
 *   1. Pick a starter from the built-in registry (or --template <url|dir>).
 *   2. Fetch it (git clone, or copy of a local directory) and read its manifest.
 *   3. Ask the questions the starter declares (name, title, feature, OpenAPI spec).
 *   4. Apply the manifest: remove -> rename -> jsonPatch -> replace -> replaceAll -> render templates.
 *   5. Install dependencies and create the first git commit.
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
 *   --skip-install          Do not run the starter's install command
 *   --skip-git              Do not initialize a git repository
 *   --yes                   Non-interactive: accept defaults for unanswered options
 */
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
    label: 'Spring Boot API, hexagonal architecture (java-starter-api)',
    template: 'https://github.com/JoanRoucoux/java-starter-api.git',
  },
};

const MANIFEST_FILE = 'generator.config.json';
const TEMPLATES_DIR = '.generator';
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
    'skip-install': { type: 'boolean', default: false },
    'skip-git': { type: 'boolean', default: false },
    yes: { type: 'boolean', short: 'y', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (args.help) {
  const header = readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0];
  console.log(header.replace(/^#![^\n]*\n\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
  exit(0);
}

const interactive = stdin.isTTY && !args.yes;

p.intro(pc.bgCyan(pc.black(' starter-generator ')));

// --- 2. Pick the starter and the target directory ----------------------------

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

// --- 3. Fetch the template and read its manifest ------------------------------

const readManifest = (root) => {
  const manifestPath = path.join(root, MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    return { error: `${template} is not a generator-enabled starter: it has no ${MANIFEST_FILE}.` };
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (cause) {
    return { error: `Invalid ${MANIFEST_FILE} in ${template}: ${cause.message}` };
  }
  if (manifest.schema !== SUPPORTED_SCHEMA) {
    return {
      error: `${MANIFEST_FILE} declares schema ${manifest.schema}, this generator supports schema ${SUPPORTED_SCHEMA}. Update the generator.`,
    };
  }
  return { manifest };
};

const spinner = p.spinner();
let manifest;

if (localTemplate) {
  // Read the manifest from the source so copyIgnore applies to the copy itself.
  const { manifest: sourceManifest, error } = readManifest(localTemplate);
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

  const { manifest: clonedManifest, error } = readManifest(targetDir);
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

// --- 4. Answers (flags first, prompts the starter declares for the rest) -----

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
      validate: (value) => (KEBAB_CASE.test(value) ? undefined : 'Use kebab-case: lowercase letters, digits, dashes.'),
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

// --- 5. Tokens ---------------------------------------------------------------

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
};

// --- 6. Apply the manifest ---------------------------------------------------

spinner.start('Applying the starter manifest');

for (const relative of manifest.remove ?? []) {
  rmSync(path.join(targetDir, relative), { recursive: true, force: true });
}

// Renames apply sequentially: each `from` sees the tree as left by the previous entries.
// Both sides are token-substituted, so module directories and package roots can take the
// application's name (`remove` above intentionally still uses literal repository paths).
for (const rename of manifest.rename ?? []) {
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

for (const patch of manifest.jsonPatch ?? []) {
  const filePath = path.join(targetDir, patch.file);
  if (!existsSync(filePath)) {
    p.log.warn(`jsonPatch target not found: ${patch.file} — template drift?`);
    continue;
  }
  const json = JSON.parse(readFileSync(filePath, 'utf8'));
  Object.assign(json, substituteDeep(patch.set ?? {}, `${MANIFEST_FILE} jsonPatch (${patch.file})`));
  for (const key of patch.delete ?? []) delete json[key];
  writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

for (const replacement of manifest.replace ?? []) {
  const filePath = path.join(targetDir, replacement.file);
  const context = `${MANIFEST_FILE} replace (${replacement.file})`;
  if (!existsSync(filePath)) {
    if (!replacement.optional) p.log.warn(`replace target not found: ${replacement.file} — template drift?`);
    continue;
  }
  const content = readFileSync(filePath, 'utf8');
  if (!content.includes(replacement.search)) {
    if (!replacement.optional) {
      p.log.warn(`Pattern not found in ${replacement.file}: ${JSON.stringify(replacement.search)} — template drift?`);
    }
    continue;
  }
  writeFileSync(filePath, content.replaceAll(replacement.search, substituteTokens(replacement.value, tokens, context)));
}

// Tree-wide literal replacement, for identities that appear in many files (Maven artifactIds,
// Java package/import statements). Binary files, .git, the manifest and the scaffold templates
// (whose {{tokens}} must survive until render) are never touched.
const collectReplaceAllFiles = (dir, files = []) => {
  for (const entry of readdirSync(dir)) {
    if (entry === '.git' || entry === TEMPLATES_DIR || entry === MANIFEST_FILE) continue;
    const entryPath = path.join(dir, entry);
    if (statSync(entryPath).isDirectory()) {
      collectReplaceAllFiles(entryPath, files);
    } else if (!BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      files.push(entryPath);
    }
  }
  return files;
};
if ((manifest.replaceAll ?? []).length > 0) {
  const files = collectReplaceAllFiles(targetDir);
  for (const replacement of manifest.replaceAll) {
    const value = substituteTokens(replacement.value, tokens, `${MANIFEST_FILE} replaceAll`);
    let touched = 0;
    for (const filePath of files) {
      if (replacement.extensions && !replacement.extensions.includes(path.extname(filePath).toLowerCase())) continue;
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

// Render the scaffold templates over the target, overwriting existing files.
const templatesRoot = path.join(targetDir, TEMPLATES_DIR, 'templates');
const renderTemplates = (dir) => {
  for (const entry of readdirSync(dir)) {
    const sourcePath = path.join(dir, entry);
    if (statSync(sourcePath).isDirectory()) {
      renderTemplates(sourcePath);
      continue;
    }
    const relative = path.relative(templatesRoot, sourcePath).replaceAll(path.sep, '/');
    const outputPath = path.join(targetDir, substitutePathTokens(relative, tokens));
    mkdirSync(path.dirname(outputPath), { recursive: true });
    if (BINARY_EXTENSIONS.has(path.extname(entry).toLowerCase())) {
      cpSync(sourcePath, outputPath);
    } else {
      writeFileSync(outputPath, substituteTokens(readFileSync(sourcePath, 'utf8'), tokens, `template ${relative}`));
    }
  }
};
if (existsSync(templatesRoot)) renderTemplates(templatesRoot);

// Wire the provided OpenAPI spec, if any.
if (openapi) {
  const openapiTarget = path.join(targetDir, manifest.openapiTarget);
  mkdirSync(path.dirname(openapiTarget), { recursive: true });
  if (/^https?:\/\//.test(openapi)) {
    const response = await fetch(openapi);
    if (!response.ok) fail(`Failed to download OpenAPI spec: HTTP ${response.status} for ${openapi}`);
    writeFileSync(openapiTarget, await response.text());
  } else {
    const openapiSource = path.resolve(openapi);
    if (!existsSync(openapiSource)) fail(`OpenAPI spec not found: ${openapiSource}`);
    cpSync(openapiSource, openapiTarget);
  }
}

// The manifest and templates describe the starter, not the generated app.
rmSync(path.join(targetDir, MANIFEST_FILE), { force: true });
rmSync(path.join(targetDir, TEMPLATES_DIR), { recursive: true, force: true });

spinner.stop('Starter manifest applied.');

// --- 7. git init, install, first commit --------------------------------------

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

// --- 8. Recap ----------------------------------------------------------------

const nextSteps = [
  `cd ${path.relative(process.cwd(), targetDir) || '.'}`,
  ...(installOk || !installCommand ? [] : [installCommand]),
  ...(manifest.nextSteps ?? []).map((step) => substituteTokens(step, tokens, `${MANIFEST_FILE} nextSteps`)),
];
p.note(nextSteps.join('\n'), 'Next steps');
p.outro(`${pc.green('Done!')} ${title} is ready in ${pc.cyan(targetDir)}`);
