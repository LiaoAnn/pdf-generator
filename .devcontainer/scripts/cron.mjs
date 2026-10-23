import { readdir, readFile, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Cron } from 'croner';
import { parse, printParseErrorCode } from 'jsonc-parser';
import {
  runningDevServers,
  viteOrigin,
  wranglerOrigin,
} from './dev-servers.mjs';

const MINUTE = 60_000;
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
]);
const viteCache = new Map();

async function modifiedAt(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function findViteConfig(directory, root) {
  while (true) {
    for (const extension of ['ts', 'mts', 'js', 'mjs', 'cts', 'cjs']) {
      const path = join(directory, `vite.config.${extension}`);
      if ((await modifiedAt(path)) !== null) return path;
    }
    if (
      directory === root ||
      (await modifiedAt(join(directory, 'package.json'))) !== null
    ) {
      return null;
    }
    directory = dirname(directory);
  }
}

async function readViteConfig(path) {
  const cached = viteCache.get(path);
  if (cached) {
    const stamps = await Promise.all(cached.files.map(modifiedAt));
    if (JSON.stringify(stamps) === JSON.stringify(cached.stamps))
      return cached.settings;
  }
  const directory = dirname(path);
  const require = createRequire(path);
  // Resolve the app's own Vite, not a separate version installed by this helper.
  const { resolveConfig } = await import(
    pathToFileURL(require.resolve('vite')).href
  );
  const config = await resolveConfig(
    { root: directory, configFile: path, logLevel: 'silent' },
    'serve',
  );
  const settings = {
    port: config.server.port ?? 5173,
    protocol: config.server.https ? 'https' : 'http',
    base: config.base,
  };
  const files = [
    ...new Set([
      path,
      ...(config.configFileDependencies ?? []),
      join(directory, 'package.json'),
      ...[
        '.env',
        '.env.local',
        '.env.development',
        '.env.development.local',
      ].map(name => join(config.envDir ?? directory, name)),
    ]),
  ];
  viteCache.set(path, {
    files,
    stamps: await Promise.all(files.map(modifiedAt)),
    settings,
  });
  return settings;
}

async function readJsonc(path) {
  const errors = [];
  const value = parse(await readFile(path, 'utf8'), errors, {
    allowTrailingComma: true,
  });
  if (errors.length) {
    const error = errors[0];
    throw new Error(
      `${printParseErrorCode(error.error)} at offset ${error.offset}`,
    );
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected a JSON object');
  }
  return value;
}

async function findConfigs(directory, diagnostics) {
  const paths = [];
  try {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        !excludedDirectories.has(entry.name)
      ) {
        paths.push(...(await findConfigs(path, diagnostics)));
      } else if (entry.isFile() && entry.name === 'wrangler.jsonc') {
        paths.push(path);
      }
    }
  } catch (error) {
    diagnostics.push(`${directory}: ${error.message}`);
  }
  return paths.sort();
}

export function parseCron(expression) {
  if (typeof expression !== 'string') throw new Error('Cron must be a string');
  const fields = expression.trim().toUpperCase().split(/\s+/);
  if (fields.length !== 5 || /[?+@]/.test(expression)) {
    throw new Error('Expected a Cloudflare five-field cron expression');
  }
  // Cloudflare uses 6L / FRIL; Croner spells the same modifier 6#L / FRI#L.
  fields[4] = fields[4].replace(/^(\d+|SUN|MON|TUE|WED|THU|FRI|SAT)L$/, '$1#L');
  return new Cron(fields.join(' '), {
    timezone: 'UTC',
    mode: '5-part',
    alternativeWeekdays: true,
    domAndDow: false,
    sloppyRanges: true,
  });
}

async function findWranglerConfig(directory, root) {
  while (!relative(root, directory).startsWith('..')) {
    const path = join(directory, 'wrangler.jsonc');
    if ((await modifiedAt(path)) !== null) return path;
    if (directory === root) break;
    directory = dirname(directory);
  }
  return null;
}

function explicitUrl(value) {
  const url = new URL(value);
  const local =
    ['localhost', '[::1]', 'host.docker.internal'].includes(url.hostname) ||
    /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!local || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(
      'Use a local HTTP(S) URL (loopback or host.docker.internal)',
    );
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/'
  ) {
    throw new Error(
      'Worker URL must be an origin without credentials, path, or query',
    );
  }
  return url.origin;
}

async function workerTarget(
  config,
  override,
  path,
  root,
  resolveVite,
  servers,
) {
  if (override.url)
    return {
      url: explicitUrl(override.url),
      environment: override.environment,
    };
  const vitePath = await findViteConfig(dirname(path), root);
  let project = dirname(path);
  while (
    project !== root &&
    (await modifiedAt(join(project, 'package.json'))) === null
  ) {
    if (vitePath && dirname(vitePath) === project) break;
    project = dirname(project);
  }
  const running = [];
  for (const server of servers) {
    if (server.kind === 'wrangler') {
      const configPath =
        server.config ?? (await findWranglerConfig(server.root, root));
      if (configPath === path) running.push(server);
    } else if (
      server.config && vitePath
        ? server.config === vitePath
        : server.root === project
    ) {
      running.push(server);
    }
  }
  if (running.length > 1) {
    throw new Error(
      'Multiple dev servers for this Worker; specify url in cron-targets.jsonc',
    );
  }
  if (!running.length) return null;
  const server = running[0];
  if (server.kind === 'wrangler') {
    if (
      override.environment !== undefined &&
      override.environment !== server.environment
    ) {
      throw new Error(
        'Selected environment does not match the running Wrangler --env',
      );
    }
    const environment = server.environment;
    const name =
      server.name ??
      config.env?.[environment]?.name ??
      (environment && config.name
        ? `${config.name}-${environment}`
        : config.name);
    const url = await wranglerOrigin(server, {
      name,
      protocol: config.dev?.local_protocol,
    });
    return { url, environment };
  }
  let url;
  try {
    url = await viteOrigin(server, {});
  } catch (error) {
    // A custom base path or HTTPS server may need settings from vite.config.*.
    if (!vitePath) throw error;
    url = await viteOrigin(server, await resolveVite(vitePath));
  }
  return { url, environment: override.environment };
}

export async function loadSchedules(
  root,
  { resolveVite = readViteConfig, servers } = {},
) {
  const diagnostics = [];
  let overrides = {};
  try {
    const config = await readJsonc(
      join(root, '.devcontainer/cron-targets.jsonc'),
    );
    overrides = config.workers ?? {};
    if (
      typeof overrides !== 'object' ||
      !overrides ||
      Array.isArray(overrides)
    ) {
      throw new Error('workers must be an object keyed by wrangler.jsonc path');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') {
      return {
        jobs: [],
        diagnostics: [`cron-targets.jsonc: ${error.message}`],
      };
    }
  }

  const workers = [];
  servers ??= await runningDevServers();
  const paths = await findConfigs(root, diagnostics);
  const found = new Set(paths.map(path => relative(root, path)));
  for (const key of Object.keys(overrides)) {
    if (!found.has(key))
      diagnostics.push(`${key}: target config was not found`);
  }
  for (const path of paths) {
    const label = relative(root, path);
    try {
      const override = overrides[label] ?? {};
      if (typeof override !== 'object' || Array.isArray(override)) {
        throw new Error('Target override must be an object');
      }
      if (override.enabled === false) continue;
      const config = await readJsonc(path);
      const target = await workerTarget(
        config,
        override,
        path,
        root,
        resolveVite,
        servers,
      );
      if (!target) {
        if (
          config.triggers?.crons?.length ||
          Object.values(config.env ?? {}).some(
            env => env.triggers?.crons?.length,
          )
        ) {
          diagnostics.push(`${label}: waiting for a running dev server`);
        }
        continue;
      }
      let triggers = config.triggers;
      if (target.environment !== undefined) {
        if (
          typeof target.environment !== 'string' ||
          !config.env?.[target.environment]
        ) {
          throw new Error(`Unknown environment: ${target.environment}`);
        }
        triggers = config.env[target.environment].triggers ?? config.triggers;
      }
      const crons = triggers?.crons ?? [];
      if (!Array.isArray(crons))
        throw new Error('triggers.crons must be an array');
      const { url } = target;
      const jobs = [];
      for (const expression of new Set(crons)) {
        try {
          const schedule = parseCron(expression);
          jobs.push({ label, url, cron: expression, schedule });
        } catch (error) {
          diagnostics.push(
            `${label}: ${JSON.stringify(expression)}: ${error.message}`,
          );
        }
      }
      workers.push({ label, url, jobs });
    } catch (error) {
      diagnostics.push(`${label}: ${error.message}`);
    }
  }

  const jobs = [];
  const destination = origin =>
    origin.replace(/localhost|\[::1\]/, '127.0.0.1');
  for (const worker of workers) {
    if (!worker.jobs.length) continue;
    const collisions = workers.filter(
      other => destination(other.url) === destination(worker.url),
    );
    if (collisions.length > 1) {
      diagnostics.push(
        `${worker.label}: shared URL ${worker.url}; set unique URLs in cron-targets.jsonc (${collisions.map(item => item.label).join(', ')})`,
      );
      continue;
    }
    jobs.push(...worker.jobs);
  }
  return { jobs, diagnostics };
}

export async function trigger(job, time, request = fetch) {
  const url = new URL('/cdn-cgi/local/scheduled', job.url);
  url.searchParams.set('cron', job.cron);
  url.searchParams.set('time', String(time));
  const response = await request(url, {
    signal: AbortSignal.timeout(10_000),
    redirect: 'error',
  });
  const body = await response.text();
  if (!response.ok || body.trim() !== 'ok') {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
  }
}

export class Scheduler {
  constructor(
    root,
    { now = Date.now(), request = fetch, log = console.log } = {},
  ) {
    this.root = root;
    this.request = request;
    this.log = log;
    this.lastMinute = Math.floor(now / MINUTE);
    this.lastConfiguration = '';
  }

  async tick(now = Date.now()) {
    const { jobs, diagnostics } = await loadSchedules(this.root);
    const signature = JSON.stringify({
      jobs: jobs.map(({ label, url, cron }) => ({ label, url, cron })),
      diagnostics,
    });
    if (signature !== this.lastConfiguration) {
      this.lastConfiguration = signature;
      this.log(`Loaded ${jobs.length} cron trigger(s). Times are UTC.`);
      for (const message of diagnostics) this.log(message);
      for (const job of jobs)
        this.log(`${job.label}: ${job.cron} -> ${job.url}`);
    }

    const minute = Math.floor(now / MINUTE);
    if (minute <= this.lastMinute) return;
    // Deliberately skip missed minutes after sleep or downtime; never replay jobs.
    this.lastMinute = minute;
    const time = minute * MINUTE;
    await Promise.all(
      jobs
        .filter(job => job.schedule.match(new Date(time)))
        .map(async job => {
          try {
            await trigger(job, time, this.request);
            this.log(
              `${job.label}: ${job.cron} at ${new Date(time).toISOString()} succeeded`,
            );
          } catch (error) {
            this.log(
              `${job.label}: ${job.cron} failed: ${error.message}; no retry`,
            );
          }
        }),
    );
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const scheduler = new Scheduler(root, {
    log: message =>
      console.log(`[dev-cron ${new Date().toISOString()}] ${message}`),
  });
  while (true) {
    try {
      await scheduler.tick();
    } catch (error) {
      scheduler.log(
        `Discovery failed: ${error.message}; checking again shortly`,
      );
    }
    await delay(Math.min(5_000, MINUTE - (Date.now() % MINUTE)));
  }
}
