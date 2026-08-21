import { readFile } from 'node:fs/promises';

const en = JSON.parse(await readFile('package.nls.json', 'utf8'));
const zh = JSON.parse(await readFile('package.nls.zh-cn.json', 'utf8'));

const enKeys = new Set(Object.keys(en));
const zhKeys = new Set(Object.keys(zh));
const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key));
const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key));
if (onlyEn.length > 0 || onlyZh.length > 0) {
  console.error(`NLS key mismatch; only-en: ${onlyEn.join(', ') || '(none)'}; only-zh: ${onlyZh.join(', ') || '(none)'}`);
  process.exit(1);
}
console.log(`all ${enKeys.size} NLS keys exist in both languages`);
