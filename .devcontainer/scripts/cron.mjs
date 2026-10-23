import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Cron } from 'croner';
import { parse, printParseErrorCode } from 'jsonc-parser';

const MINUTE = 60_000;
const excludedDirectories = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
]);

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

function explicitUrl(value) {
  const url = new URL(value);
  // IP literals only: which address `localhost` resolves to first varies.
  const loopback =
    url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
  if (!loopback || !['http:', 'https:'].includes(url.protocol)) {
    throw new Error(
      'Use a loopback HTTP(S) URL with an IP literal (127.0.0.1 or [::1])',
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

export async function loadSchedules(root) {
  const diagnostics = [];
  let targets = {};
  try {
    const config = await readJsonc(
      join(root, '.devcontainer/cron-targets.jsonc'),
    );
    targets = config.workers ?? {};
    if (typeof targets !== 'object' || !targets || Array.isArray(targets)) {
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
  const paths = await findConfigs(root, diagnostics);
  const found = new Set(paths.map(path => relative(root, path)));
  for (const key of Object.keys(targets)) {
    if (!found.has(key))
      diagnostics.push(`${key}: target config was not found`);
  }
  for (const path of paths) {
    const label = relative(root, path);
    try {
      const target = targets[label] ?? {};
      if (typeof target !== 'object' || !target || Array.isArray(target)) {
        throw new Error('Target must be an object');
      }
      if (target.enabled === false) continue;
      const config = await readJsonc(path);
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
      if (target.url === undefined) {
        if (crons.length) {
          diagnostics.push(
            `${label}: not scheduled; add its url to .devcontainer/cron-targets.jsonc`,
          );
        }
        continue;
      }
      const url = explicitUrl(target.url);
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
  for (const worker of workers) {
    if (!worker.jobs.length) continue;
    const collisions = workers.filter(other => other.url === worker.url);
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
        `Loading schedules failed: ${error.message}; checking again shortly`,
      );
    }
    await delay(Math.min(5_000, MINUTE - (Date.now() % MINUTE)));
  }
}
