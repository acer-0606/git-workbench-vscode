import { readFile } from 'node:fs/promises';

const schema = JSON.parse(await readFile('config/settings.schema.json', 'utf8'));
const en = JSON.parse(await readFile('package.nls.json', 'utf8'));
const zh = JSON.parse(await readFile('package.nls.zh-cn.json', 'utf8'));

const missing = [];
for (const setting of schema.settings) {
  const key = `config.${setting.key}`;
  if (!en[key] || !en[key].trim()) missing.push(`en:${key}`);
  if (!zh[key] || !zh[key].trim()) missing.push(`zh:${key}`);
  if (setting.enumDescriptionKeys) {
    for (const enumKey of setting.enumDescriptionKeys) {
      if (!en[enumKey] || !zh[enumKey]) missing.push(`enum:${enumKey}`);
    }
  }
}
if (missing.length > 0) {
  console.error(`Missing NLS entries: ${missing.join(', ')}`);
  process.exit(1);
}
console.log(`all ${schema.settings.length} settings carry complete en/zh NLS`);
