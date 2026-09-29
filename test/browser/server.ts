import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createControlServer } from '../../src/control-server.js';
import { seedRuns } from './seed.js';

const directory = await mkdtemp(join(tmpdir(), 'github-issue-browser-'));
const envPath = join(directory, '.env');
const dataDir = await seedRuns(directory);
await writeFile(envPath, `# Browser test fixture\nUNRELATED=preserved\nDATA_DIR=${dataDir}\n`, { mode: 0o600 });
const server = createControlServer({ envPath, fetch: (async () => Response.json({ full_name: 'example/repository' })) as typeof fetch });
server.listen(3187, '127.0.0.1');
const stop = () => server.close(() => { void rm(directory, { recursive: true, force: true }).then(() => process.exit(0)); });
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
