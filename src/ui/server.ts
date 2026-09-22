import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { CredentialStore } from '../storage.js';
import { safeError } from '../errors.js';
import { SetupService } from './setup.js';

class PluginUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const storage = this.homebridgeStoragePath;
    if (!storage) throw new Error('Homebridge storage path is unavailable');
    const setup = new SetupService(new CredentialStore(storage));
    for (const path of ['/status', '/auth/send', '/auth/verify', '/auth/logout', '/devices', '/config/validate', '/device/read', '/device/apply']) {
      this.onRequest(path, async (payload: unknown) => {
        try { return { result: await setup.handle(path, payload) }; }
        catch (error) { throw new RequestError(safeError(error), { message: safeError(error) }); }
      });
    }
    this.ready();
  }
}
new PluginUiServer();
