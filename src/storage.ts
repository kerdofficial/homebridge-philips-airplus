import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PluginError } from './errors.js';

const credentialsSchema = z.object({ uid: z.string().min(1), signingSecret: z.string().min(1) });
export type Credentials = z.infer<typeof credentialsSchema>;

export class CredentialStore {
  readonly directory: string;
  constructor(storagePath: string) { this.directory = join(storagePath, 'philips-airplus'); }

  async read(): Promise<Credentials | undefined> {
    try {
      return credentialsSchema.parse(JSON.parse(await readFile(join(this.directory, 'credentials.json'), 'utf8')));
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new PluginError('Stored credentials are invalid');
    }
  }

  async write(credentials: Credentials): Promise<void> {
    const valid = credentialsSchema.parse(credentials);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(valid), { mode: 0o600, flag: 'wx' });
      await rename(temporary, join(this.directory, 'credentials.json'));
    } finally { await rm(temporary, { force: true }); }
  }

  async clear(): Promise<void> { await rm(join(this.directory, 'credentials.json'), { force: true }); }
}
