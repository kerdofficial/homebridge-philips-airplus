import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
const result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' }));
const files = result[0].files.map(file => file.path);
const allowed = /^(?:dist\/(?!ui\/browser\.)[^\s]+\.(?:js|d\.ts)|homebridge-ui\/(?:server\.js|public\/(?:index\.html|app\.css|app\.js))|package\.json|README\.md|LICENSE|config\.schema\.json)$/;
for (const file of files) {
  if (!allowed.test(file)) throw new Error(`Unexpected package file: ${file}`);
  const content = await readFile(file, 'utf8');
  if (/\/Users\/|\/Volumes\/|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content)) throw new Error(`Private content in package: ${file}`);
}
for (const required of ['dist/index.js', 'homebridge-ui/server.js', 'homebridge-ui/public/app.js', 'config.schema.json', 'README.md', 'LICENSE']) {
  if (!files.includes(required)) throw new Error(`Missing package file: ${required}`);
}
console.log(`Package audit passed: ${files.length} files.`);
