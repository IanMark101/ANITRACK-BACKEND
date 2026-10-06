import { loadConfig } from './config.js';
import { prisma } from './db.js';
import { createApp } from './app.js';

try {
  const config = loadConfig();
  const server = createApp(prisma, config).listen(config.PORT, () =>
    console.log(`AniTrack API listening on http://localhost:${config.PORT}`)
  );
  for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => {
      server.close(async () => {
        await prisma.$disconnect();
        process.exit(0);
      });
    });
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Unable to start API');
  process.exit(1);
}
