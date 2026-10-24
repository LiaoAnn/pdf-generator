// Vitest setup: every apps/web test file gets its own wrangler dev registry.
// getPlatformProxy watches the registry folder (this Worker binds PRINT and a
// queue) and waits for that watcher with no timeout. In a folder that other
// test files' Workers keep registering in and leaving, the wait hung for good
// (T09-3: 4 of 4 runs with a busy folder, 0 of 25 with a quiet one). Tests
// never reach another Worker through the registry.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const registry = mkdtempSync(join(tmpdir(), 'web-test-registry-'));
process.env.WRANGLER_REGISTRY_PATH = registry;
afterAll(() => rmSync(registry, { recursive: true, force: true }));
