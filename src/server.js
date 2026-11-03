import { readConfig } from './config.js';
import { CodexRunner } from './codex.js';
import { GenerationQueue } from './queue.js';
import { createServer } from './http.js';
import { CodexAuthManager } from './auth.js';
import { GenerationResources } from './resources.js';

async function main() {
  const config = readConfig();
  const runner = new CodexRunner(config);
  await runner.initializeAuthState();
  const authManager = new CodexAuthManager(config, undefined, authenticated => runner.authenticationChanged(authenticated));
  await runner.inspectVersion();
  await runner.authStatus(); // One online check at startup; reads of /auth/status are local snapshots.
  const resources = new GenerationResources(config);
  await resources.refresh();
  const queue = new GenerationQueue(config, runner, resources);
  await queue.initialize();
  const server = createServer(config, queue, runner, authManager);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });
  console.info(`Generation agent on ${config.host}:${config.port}; Codex ${runner.version ?? 'unavailable'}; ${config.model}/${config.reasoningEffort}`);
  const interval = setInterval(() => { void queue.tick(); }, 500);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);
    const closed = new Promise(resolve => server.close(resolve));
    server.closeIdleConnections();
    await authManager.stop();
    await queue.stop();
    await closed;
  };
  process.on('SIGINT', () => { void shutdown(); });
  process.on('SIGTERM', () => { void shutdown(); });
}

main().catch(() => {
  console.error('Generation agent startup failed. Check environment, port and data volume.');
  process.exitCode = 1;
});
