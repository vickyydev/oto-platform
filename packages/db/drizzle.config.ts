import { defineConfig } from 'drizzle-kit';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL must be set (see .env.example at the repository root)');
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL },
  strict: true,
  verbose: true,
});
