import { mkdir, writeFile } from 'node:fs/promises';
await mkdir('homebridge-ui', { recursive: true });
await writeFile('homebridge-ui/server.js', "import '../dist/ui/server.js';\n");
