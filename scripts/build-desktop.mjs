import {spawnSync} from 'node:child_process';
import path from 'node:path';
import {existsSync} from 'node:fs';
const root=path.resolve(import.meta.dirname,'..');
const env={...process.env,ELECTRON_BUILDER_CACHE:path.join(root,'logs/electron-builder-cache'),electron_config_cache:path.join(root,'logs/electron-cache'),npm_config_cache:path.join(root,'logs/npm-cache')};
if(!existsSync(path.join(root,'node_modules/electron/dist/version'))){const installed=spawnSync(process.execPath,[path.join(root,'scripts/install-electron.mjs')],{cwd:root,env,stdio:'inherit'});if(installed.status!==0)process.exit(installed.status??1);}
const result=spawnSync(path.join(root,'node_modules/.bin/electron-builder'),['--mac','dir'],{cwd:root,env,stdio:'inherit'});process.exit(result.status??1);
