process.env.POKEARENA_ALLOW_DEMO_AUTH = 'true';
process.env.POKEARENA_LOCAL_TEST_MODE = 'true';

const { ApiServer } = require('../dist/src/server.js');

ApiServer.create().then(server => {
  const port = Number(process.env.PORT ?? 3000);
  return server.listen(port).then(bound => {
    console.log(`PokeArena development API listening on http://${server.bindHost}:${bound}`);
    console.log('Demo authentication is enabled for this development process.');
    console.log('Local tournament test mode is enabled for this development process.');
  });
}).catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
