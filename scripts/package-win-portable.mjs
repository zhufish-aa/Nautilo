import { packageDesktop } from './package-desktop.mjs';

if (process.platform !== 'win32') throw new Error('Run Windows packaging on Windows.');
await packageDesktop(['portable', 'zip']);
