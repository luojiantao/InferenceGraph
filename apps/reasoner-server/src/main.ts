import { createReasonerApplication } from './app.js';
import { loadReasonerServerConfig } from './config.js';

const main = async (): Promise<void> => {
  const config = loadReasonerServerConfig(process.env);
  const app = await createReasonerApplication(config);
  const url = await app.listen();
  app.log.info(
    { url, dataDir: config.dataDir, logFile: app.logging.logFilePath },
    'reasoner server listening',
  );
  // Always on stdout: if logging is silenced or file-only, the operator still
  // needs to know where to look.
  console.info(`reasoner listening on ${url} · logs: ${app.logging.logFilePath}`);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    void app
      .close()
      .then(() => process.exit(0))
      .catch((cause: unknown) => {
        console.error('shutdown failed', cause);
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
};

main().catch((cause: unknown) => {
  console.error('reasoner server failed to start', cause);
  process.exit(1);
});
