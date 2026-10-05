import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const result=spawnSync(process.execPath,[path.join(root,'node_modules/electron/install.js')],{cwd:root,stdio:'inherit',env:{...process.env,electron_config_cache:path.join(root,'logs/electron-cache'),npm_config_cache:path.join(root,'logs/npm-cache')}});process.exit(result.status??1);
