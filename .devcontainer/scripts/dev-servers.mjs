import { readdir, readFile, readlink } from 'node:fs/promises';
import { resolve } from 'node:path';

function option(args, name) {
  const inline = args.find(arg => arg.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

export function viteCommand(argv, cwd) {
  const index = argv.findIndex(arg => /(?:^|\/)vite(?:\.js)?$/.test(arg));
  if (index === -1) return null;
  const args = argv.slice(index + 1);
  if (['build', 'preview', 'optimize'].includes(args[0])) return null;
  if (['dev', 'serve'].includes(args[0])) args.shift();
  const root = args[0] && !args[0].startsWith('-') ? args[0] : '.';
  const config = option(args, '--config') ?? option(args, '-c');
  return {
    kind: 'vite',
    root: resolve(cwd, root),
    config: config ? resolve(cwd, config) : undefined,
    port: option(args, '--port'),
    base: option(args, '--base'),
  };
}

export function wranglerCommand(argv, cwd) {
  const index = argv.findIndex(
    arg =>
      /(?:^|\/)wrangler(?:\.js)?$/.test(arg) ||
      /\/wrangler-dist\/cli\.js$/.test(arg),
  );
  if (index === -1) return null;
  const args = argv.slice(index + 1);
  if (
    !args.includes('dev') ||
    args.includes('pages') ||
    args.some(arg => arg === '--remote' || arg === '--remote=true')
  )
    return null;
  const config = option(args, '--config') ?? option(args, '-c');
  return {
    kind: 'wrangler',
    root: cwd,
    config: config ? resolve(cwd, config) : undefined,
    port: option(args, '--port'),
    protocol: option(args, '--local-protocol'),
    environment: option(args, '--env') ?? option(args, '-e'),
    name: option(args, '--name'),
  };
}

async function listeningSockets() {
  const sockets = new Map();
  for (const family of ['tcp', 'tcp6']) {
    let table;
    try {
      table = await readFile(`/proc/net/${family}`, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    for (const line of table.trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] !== '0A') continue;
      const [address, hexPort] = fields[1].split(':');
      // Vite is normally bound to loopback or all interfaces inside the container.
      const host = family === 'tcp6' ? '[::1]' : '127.0.0.1';
      if (family === 'tcp' && !['00000000', '0100007F'].includes(address))
        continue;
      sockets.set(fields[9], { host, port: Number.parseInt(hexPort, 16) });
    }
  }
  return sockets;
}

export async function runningDevServers() {
  const processes = new Map();
  const sockets = await listeningSockets();
  for (const pid of await readdir('/proc')) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8'))
        .split('\0')
        .filter(Boolean);
      const cwd = await readlink(`/proc/${pid}/cwd`);
      const command = viteCommand(argv, cwd) ?? wranglerCommand(argv, cwd);
      const status = await readFile(`/proc/${pid}/status`, 'utf8');
      const parent = /^PPid:\s+(\d+)$/m.exec(status)?.[1];
      const listeners = [];
      // Wrangler delegates its public HTTP socket to a child workerd process.
      const runtime = /(?:^|\/)workerd$/.test(argv[0] ?? '');
      for (const fd of command || runtime
        ? await readdir(`/proc/${pid}/fd`)
        : []) {
        try {
          const link = await readlink(`/proc/${pid}/fd/${fd}`);
          const socket = sockets.get(/^socket:\[(\d+)\]$/.exec(link)?.[1]);
          if (socket)
            listeners.push({
              ...socket,
              // Wrangler puts the inspected user runtime behind its public proxy.
              inspectedRuntime:
                runtime &&
                argv.some(arg => arg.startsWith('--inspector-addr=')),
            });
        } catch (error) {
          if (!['ENOENT', 'EACCES'].includes(error.code)) throw error;
        }
      }
      processes.set(pid, { command, pid, parent, listeners });
    } catch (error) {
      if (!['ENOENT', 'EACCES', 'ESRCH'].includes(error.code)) throw error;
    }
  }
  const servers = [];
  for (const process of processes.values()) {
    if (!process.command) continue;
    // Use the innermost CLI process, not its package-manager/bin wrapper.
    const owned = [...process.listeners];
    let wrapper = false;
    for (const child of processes.values()) {
      let ancestor = processes.get(child.parent);
      while (ancestor) {
        if (ancestor.pid === process.pid) {
          if (child.command) wrapper = true;
          else if (process.command.kind === 'wrangler')
            owned.push(...child.listeners);
          break;
        }
        if (ancestor.command) break;
        ancestor = processes.get(ancestor.parent);
      }
    }
    if (!wrapper)
      servers.push({ ...process.command, pid: process.pid, listeners: owned });
  }
  return servers;
}

export async function wranglerOrigin(server, { protocol = 'http', name } = {}) {
  const matches = [];
  await Promise.all(
    server.listeners.map(async ({ host, port, inspectedRuntime }) => {
      const origin = `${server.protocol ?? protocol}://${host}:${port}`;
      try {
        // Read-only discovery. Never invoke scheduled handlers to probe a port.
        const response = await fetch(
          `${origin}/cdn-cgi/local/explorer/api/local/workers`,
          {
            signal: AbortSignal.timeout(1_000),
            redirect: 'error',
          },
        );
        if (!response.ok) return;
        const data = await response.json();
        if (
          data.success === true &&
          Array.isArray(data.result) &&
          data.result.some(
            worker => worker.isSelf === true && (!name || worker.name === name),
          )
        ) {
          matches.push({ origin, inspectedRuntime });
        }
      } catch {
        // Inspector, internal sockets, and servers still starting are not destinations.
      }
    }),
  );
  const publicMatches = matches.filter(match => !match.inspectedRuntime);
  const unique = [
    ...new Set(
      (publicMatches.length ? publicMatches : matches).map(
        match => match.origin,
      ),
    ),
  ];
  if (unique.length !== 1) {
    throw new Error(
      `Wrangler PID ${server.pid}: could not identify a unique local Worker HTTP server (${unique.join(', ') || 'no matching port'}); specify url in cron-targets.jsonc`,
    );
  }
  return unique[0];
}

export async function viteOrigin(server, settings) {
  const preferredPort = Number(server.port ?? settings.port ?? 5173);
  const listeners = [...server.listeners].sort(
    (a, b) =>
      Number(b.port === preferredPort) - Number(a.port === preferredPort),
  );
  const base = server.base ?? settings.base ?? '/';
  const matches = [];
  for (const { host, port } of listeners) {
    const origin = `${settings.protocol ?? 'http'}://${host}:${port}`;
    try {
      // Vite can own HMR/inspector/Cloudflare sockets too. Only select its HTTP server.
      const path = `${base.replace(/\/$/, '')}/@vite/client`;
      const response = await fetch(new URL(path, origin), {
        signal: AbortSignal.timeout(1_000),
        redirect: 'error',
      });
      const body = await response.text();
      if (response.ok && body.includes('createHotContext'))
        matches.push(origin);
    } catch {
      // Non-HTTP sockets and servers still starting are not cron destinations.
    }
  }
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new Error(
      `Vite PID ${server.pid}: could not identify a unique HTTP server; specify url in cron-targets.jsonc`,
    );
  }
  return unique[0];
}
