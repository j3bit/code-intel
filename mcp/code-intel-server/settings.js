import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

export const PLUGIN_VERSION = '0.2.0';
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const DEFAULT_SETTINGS_PATH = path.join(ROOT, 'settings', 'defaults.json');
export const SETTINGS_SCHEMA_PATH = path.join(ROOT, 'settings', 'schema.json');

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function typeMatches(value, expected) {
  const actual = typeOf(value);
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}

export function resolveHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

export function defaultUserSettingsPath() {
  return path.join(resolveHomeDir(), '.codex', 'code-intel', 'settings.json');
}

export function expandHome(value) {
  if (typeof value !== 'string') return value;
  const homeDir = resolveHomeDir();
  if (value === '~') return homeDir || value;
  if (value.startsWith('~/')) return homeDir ? path.join(homeDir, value.slice(2)) : value;
  return value;
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
  if (!isPlainObject(override)) return base;
  const out = typeof structuredClone === 'function'
    ? structuredClone(base)
    : JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(override)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = deepMerge(out[key], value);
    else out[key] = value;
  }
  return out;
}

export function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  return readJson(file);
}

export function settingsSourceError(source, file, message) {
  const error = new Error(`settings schema validation failed: ${source} settings ${message}: ${file}`);
  error.validationErrors = [`${source} settings ${message}: ${file}`];
  return error;
}

export function readSettingsOverrideIfExists(file, source) {
  const settings = readJsonIfExists(file);
  if (settings === null) return null;
  if (!isPlainObject(settings)) {
    throw settingsSourceError(source, file, `root expected object but got ${typeOf(settings)}`);
  }
  return settings;
}

export function normalizeSettingsPaths(settings) {
  if (typeof settings?.astGrep?.configPath === 'string') {
    settings.astGrep.configPath = expandHome(settings.astGrep.configPath);
  }
  if (Array.isArray(settings?.path?.extraDirs)) {
    settings.path.extraDirs = settings.path.extraDirs.map(expandHome);
  }
  return settings;
}

export function validateAgainstSchema(value, schema, pathLabel = '$') {
  const errors = [];
  function visit(current, currentSchema, label) {
    if (!currentSchema || typeof currentSchema !== 'object') return;
    if (currentSchema.type && !typeMatches(current, currentSchema.type)) {
      errors.push(`${label} expected ${Array.isArray(currentSchema.type) ? currentSchema.type.join(' or ') : currentSchema.type} but got ${typeOf(current)}`);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(currentSchema, 'const') && current !== currentSchema.const) {
      errors.push(`${label} expected ${JSON.stringify(currentSchema.const)}`);
    }
    if (currentSchema.enum && !currentSchema.enum.includes(current)) {
      errors.push(`${label} expected one of ${currentSchema.enum.join(', ')}`);
    }
    if (currentSchema.minLength !== undefined && typeof current === 'string' && current.length < currentSchema.minLength) {
      errors.push(`${label} expected length >= ${currentSchema.minLength}`);
    }
    if (currentSchema.minItems !== undefined && Array.isArray(current) && current.length < currentSchema.minItems) {
      errors.push(`${label} expected at least ${currentSchema.minItems} items`);
    }
    if (currentSchema.not?.const !== undefined && current === currentSchema.not.const) {
      errors.push(`${label} must not be ${JSON.stringify(currentSchema.not.const)}`);
    }
    if (currentSchema.pattern && typeof current === 'string' && !(new RegExp(currentSchema.pattern).test(current))) {
      errors.push(`${label} does not match pattern ${currentSchema.pattern}`);
    }
    if (currentSchema.required && typeof current === 'object' && current !== null) {
      for (const key of currentSchema.required) {
        if (!Object.prototype.hasOwnProperty.call(current, key)) errors.push(`${label}.${key} is required`);
      }
    }
    if (currentSchema.properties && typeof current === 'object' && current !== null && !Array.isArray(current)) {
      for (const [key, propertySchema] of Object.entries(currentSchema.properties)) {
        if (Object.prototype.hasOwnProperty.call(current, key)) visit(current[key], propertySchema, `${label}.${key}`);
      }
    }
    if (currentSchema.items && Array.isArray(current)) {
      current.forEach((item, index) => visit(item, currentSchema.items, `${label}[${index}]`));
    }
    if (currentSchema.additionalProperties === false && isPlainObject(current)) {
      const allowed = new Set(Object.keys(currentSchema.properties || {}));
      for (const key of Object.keys(current)) {
        if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
      }
    }
    if (isPlainObject(currentSchema.additionalProperties) && isPlainObject(current)) {
      const explicit = new Set(Object.keys(currentSchema.properties || {}));
      for (const [key, item] of Object.entries(current)) {
        if (!explicit.has(key)) visit(item, currentSchema.additionalProperties, `${label}.${key}`);
      }
    }
  }
  visit(value, schema, pathLabel);
  return errors;
}

export function validateSettings(settings) {
  const schema = readJson(SETTINGS_SCHEMA_PATH);
  const errors = validateAgainstSchema(settings, schema, '$');
  if (settings?.astGrep?.command === 'sg') errors.push('$.astGrep.command must be ast-grep or another explicit executable, not sg');
  if (errors.length) {
    const error = new Error(`settings schema validation failed: ${errors.slice(0, 8).join('; ')}`);
    error.validationErrors = errors;
    throw error;
  }
  return settings;
}

export function loadSettings(repoRoot = process.cwd(), opts = {}) {
  const defaultPath = opts.defaultSettingsPath || process.env.CODE_INTEL_DEFAULT_SETTINGS_PATH || DEFAULT_SETTINGS_PATH;
  const userPath = opts.userSettingsPath || process.env.CODE_INTEL_USER_SETTINGS_PATH || defaultUserSettingsPath();
  const projectPath = opts.projectSettingsPath || process.env.CODE_INTEL_PROJECT_SETTINGS_PATH || path.join(path.resolve(repoRoot), '.code-intel', 'settings.json');
  const defaults = readJson(defaultPath);
  const expandedUserPath = expandHome(userPath);
  const expandedProjectPath = expandHome(projectPath);
  const user = readSettingsOverrideIfExists(expandedUserPath, 'user');
  const project = readSettingsOverrideIfExists(expandedProjectPath, 'project');
  const merged = validateSettings(normalizeSettingsPaths(deepMerge(deepMerge(defaults, user || {}), project || {})));
  Object.defineProperty(merged, 'sources', {
    enumerable: false,
    value: {
      default: defaultPath,
      user: user ? expandedUserPath : null,
      project: project ? expandedProjectPath : null
    }
  });
  return merged;
}

export function splitCommandLine(commandLine) {
  const parts = [];
  let current = '';
  let quote = null;
  for (const char of String(commandLine || '').trim()) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export function firstToken(commandLine) {
  return splitCommandLine(commandLine)[0] || '';
}
