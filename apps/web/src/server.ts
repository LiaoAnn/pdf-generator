import { env } from 'cloudflare:workers';
import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';
import type { LocalAccess } from './access/local.ts';
import { accessConfigFromEnv } from './access/verify.ts';
import { consumeFixtures } from './batch/queue.ts';
import { createFetchHandler } from './worker.ts';

export { BatchWorkflow } from './batch/workflow.ts';

const startFetch = createStartHandler(defaultStreamHandler);

// `vite dev` stands in for the Cloudflare Access edge; `vite build` replaces
// import.meta.env.DEV with false and drops the stand-in from the bundle.
let local: Promise<LocalAccess> | undefined;
if (import.meta.env.DEV) {
  local = import('./access/local.ts').then(m => m.createLocalAccess());
}
const localAccess = local && (await local);

const handle = createFetchHandler({
  pages: async request => startFetch(request),
  ...(localAccess
    ? {
        access: () => localAccess.config,
        edge: localAccess.edge,
        loginUrl: '/__access/login',
      }
    : { access: accessConfigFromEnv }),
});

export default {
  ...createServerEntry({ fetch: request => handle(request, env) }),
  queue: consumeFixtures,
};
