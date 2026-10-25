// Types for the *.workerd.test.ts files (vitest.workerd.config.ts).
/// <reference types="@cloudflare/vitest-plugin/types" />

declare module 'vitest' {
  interface ProvidedContext {
    /** Repo files the tests upload, base64 keyed by path from the repo root. */
    repoFiles: Record<string, string>;
  }
}

export {};
