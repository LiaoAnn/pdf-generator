import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineProject } from 'vitest/config';
import { unstable_readConfig } from 'wrangler';

// Tests that must run inside workerd, where node:zlib and other Node APIs
// behave differently from Node. They get the Worker's own compatibility date
// and flags but none of its bindings: T09-2 adds those when it moves tests
// that need them.
const { compatibility_date, compatibility_flags } = unstable_readConfig({
  config: `${import.meta.dirname}/wrangler.jsonc`,
});

export default defineProject({
  plugins: [
    cloudflareTest({
      miniflare: {
        compatibilityDate: compatibility_date,
        compatibilityFlags: compatibility_flags,
      },
    }),
  ],
  test: {
    name: '@pdf-generator/web (workerd)',
    include: ['src/**/*.workerd.test.ts'],
  },
});
