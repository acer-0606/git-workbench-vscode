import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const schemaPath = fileURLToPath(
  new URL('../config/settings.schema.json', import.meta.url),
);

if (!existsSync(schemaPath)) {
  console.log('settings schema not initialized; sync skipped');
}
