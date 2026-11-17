import { existsSync } from 'node:fs';

// Local runs read backend/.env; CI provides the variables directly.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}
