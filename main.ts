// main.ts — entrypoint: start the forge, register with the environment,
// wait for completion. Keep this file as it is.

import { createApp, createStore } from './app.ts';

function registerAndWait(): void {
  const envUrl = process.env.MAKEFUN_ENV_URL;
  if (!envUrl) {
    throw new Error('MAKEFUN_ENV_URL is not set');
  }
  const store = createStore();
  const server = createApp(store);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    fetch(`${envUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port }),
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`register failed: ${response.status}`);
        }
        for (;;) {
          const doneResponse = await fetch(`${envUrl}/done`);
          const doneJson = (await doneResponse.json()) as { done?: boolean };
          if (doneJson.done) {
            server.close();
            process.exit(0);
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      })
      .catch((error) => {
        console.error(error);
        process.exit(1);
      });
  });
}

registerAndWait();
