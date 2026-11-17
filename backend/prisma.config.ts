import { existsSync } from 'node:fs';
import { defineConfig } from 'prisma/config';

// Local development convenience only: containers and CI inject real environment variables.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env['DATABASE_URL'] ?? '',
    shadowDatabaseUrl: process.env['SHADOW_DATABASE_URL'],
  },
});
