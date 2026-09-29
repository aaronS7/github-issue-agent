import { resolve } from 'node:path';
import { createControlServer } from './control-server.js';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Expected a value after ${name}`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log('Usage: npm run ui -- [--port PORT] [--env-file PATH] [--public-url https://HOST:PORT]');
    return;
  }
  const portValue = option('--port') ?? process.env.UI_PORT ?? '3100';
  const port = Number(portValue);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid UI port');
  const envPath = resolve(option('--env-file') ?? process.env.UI_ENV_FILE ?? '.env');
  const publicUrl = option('--public-url') ?? process.env.UI_PUBLIC_URL;
  const server = createControlServer({
    envPath,
    ...(publicUrl ? { publicUrl } : {}),
    allowedOrigins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
  });
  await new Promise<void>((done, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', done);
  });
  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`Configuration console: http://127.0.0.1:${actualPort}/`);
  if (publicUrl) console.log(`Private proxy URL: ${new URL(publicUrl).origin}/`);
  console.log(`Editing ${envPath}. Restart the issue bot after saving.`);
  await new Promise<void>((done) => {
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
  });
  await new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done()));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unable to start configuration console');
  process.exitCode = 1;
});
