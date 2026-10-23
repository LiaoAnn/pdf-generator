import { env } from 'cloudflare:workers';
import {
  createServerEntry,
  createStartHandler,
  defaultStreamHandler,
} from '@tanstack/react-start/server';
import { createFetchHandler } from './worker.ts';

const startFetch = createStartHandler(defaultStreamHandler);

const handle = createFetchHandler({
  pages: async request => startFetch(request),
});

export default createServerEntry({ fetch: request => handle(request, env) });
