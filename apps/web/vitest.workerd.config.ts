import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';
import { unstable_readConfig } from 'wrangler';

// Tests that must run inside workerd, where node:zlib and other Node APIs
// behave differently from Node. They get the Worker's own compatibility date
// and flags, an empty local D1 and R2 under its binding names, and the D1
// migrations to apply; no PRINT, queue or workflow.
const { compatibility_date, compatibility_flags } = unstable_readConfig({
  config: `${import.meta.dirname}/wrangler.jsonc`,
});

// workerd can't read the repo, so the files the tests upload are read here,
// as base64 keyed by their path from the repo root.
const root = join(import.meta.dirname, '../..');
const fixtures = [
  'packages/template-tools/fixtures/valid',
  'apps/print/src/test-fixtures/pack-font/report.woff2',
  'apps/print/public/fonts/NotoSansTC-Regular.otf',
].flatMap(path =>
  statSync(join(root, path)).isFile()
    ? [join(root, path)]
    : readdirSync(join(root, path), { recursive: true, withFileTypes: true })
        .filter(entry => entry.isFile())
        .map(entry => join(entry.parentPath, entry.name)),
);

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: compatibility_date,
        compatibilityFlags: compatibility_flags,
        d1Databases: ['DB'],
        r2Buckets: ['FILES'],
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            `${import.meta.dirname}/drizzle`,
          ),
        },
      },
    }),
  ],
  test: {
    name: '@pdf-generator/web (workerd)',
    include: ['src/**/*.workerd.test.ts'],
    provide: {
      repoFiles: Object.fromEntries(
        fixtures.map(file => [
          relative(root, file),
          readFileSync(file).toString('base64'),
        ]),
      ),
    },
  },
});
