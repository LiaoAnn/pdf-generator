// `pnpm dev` entry: runs `vite dev`, also accepting wrangler's `--ip <addr>`
// (the dev VM starts every Worker with `pnpm dev --ip 0.0.0.0`), which Vite
// calls `--host`.
import { spawn } from 'node:child_process';

/** Translates `pnpm dev` arguments into `vite dev` arguments. */
export function viteDevArgs(args: readonly string[]): string[] {
  return args.flatMap(arg =>
    arg === '--ip'
      ? ['--host']
      : arg.startsWith('--ip=')
        ? ['--host', arg.slice('--ip='.length)]
        : [arg],
  );
}

if (import.meta.main) {
  const vite = spawn('vite', ['dev', ...viteDevArgs(process.argv.slice(2))], {
    stdio: 'inherit',
  });
  vite.on('exit', code => process.exit(code ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => vite.kill(signal));
  }
}
