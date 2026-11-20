import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const agy = join(root, 'rust/plugins/antigravity/resources/model-gateway/upstream');

export function copyAccountNotices(directory) {
  const files = [
    ['MAGPIE-LICENSE.txt', join(root, 'docs/third-party/MAGPIE-LICENSE.txt')],
    ['MAGPIE-AGY-LICENSE.txt', join(agy, 'LICENSE')],
    ['MAGPIE-AGY-NOTICE.md', join(agy, 'NOTICE.md')],
    ['MAGPIE-ACCOUNT-PORTS.md', join(root, 'docs/magpie-account-ports.md')],
  ];
  for (const [name, source] of files) {
    const destination = join(directory, 'licenses', name);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}
