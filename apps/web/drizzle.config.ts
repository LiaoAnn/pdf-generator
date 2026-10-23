import { defineConfig } from 'drizzle-kit';

// `pnpm db:generate` writes migrations to drizzle/; wrangler applies them
// (`pnpm db:migrate:local`, `pnpm db:migrate:remote`).
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
