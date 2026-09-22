import { mkdir, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
await mkdir('homebridge-ui', { recursive: true });
await writeFile('homebridge-ui/server.js', "import '../dist/ui/server.js';\n");
await build({ entryPoints: ['src/ui/browser.ts'], outfile: 'homebridge-ui/public/app.js', bundle: true, platform: 'browser', target: 'es2022', minify: true });
