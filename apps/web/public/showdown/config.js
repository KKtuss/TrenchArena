(function () {
  var client = window.location.host + '/showdown';
  var root = window.location.host;
  window.Config = {
    version: 'pokearena-showdown-client-c24f883',
    routes: {
      root: root,
      client: client,
      dex: client,
      replays: client,
      users: client,
      teams: client,
    },
    server: {
      id: 'pokearena',
      host: window.location.hostname,
      port: window.location.port || (window.location.protocol === 'https:' ? 443 : 80),
    },
  };
})();
