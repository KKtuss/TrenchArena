(() => {
  let socket;
  let identity;
  let latestState;
  let latestMatch;

  const $ = id => document.getElementById(id);
  const log = value => {
    $('log').textContent += `${new Date().toISOString()} ${JSON.stringify(value)}\n`;
    $('log').scrollTop = $('log').scrollHeight;
  };
  const send = message => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return log({ error: 'not connected' });
    socket.send(JSON.stringify({
      requestId: crypto.randomUUID(),
      ...message,
    }));
  };

  $('connect').onclick = () => {
    identity = $('identity').value;
    socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    socket.onopen = () => {
      $('connection').textContent = 'connected';
      send({ type: 'identify', playerId: identity });
    };
    socket.onclose = () => $('connection').textContent = 'closed';
    socket.onerror = error => log({ type: 'socket.error', error: String(error) });
    socket.onmessage = event => handle(JSON.parse(event.data));
  };
  $('create').onclick = () => send({ type: 'tournament.create', title: 'Browser Demo Cup', maxPlayers: 4 });
  $('join').onclick = () => send({
    type: 'tournament.join',
    tournamentId: $('tournamentId').value.trim(),
  });
  $('start').onclick = () => send({
    type: 'tournament.start',
    tournamentId: $('tournamentId').value.trim(),
  });
  $('subscribe').onclick = () => send({
    type: 'match.subscribe',
    matchId: $('matchId').value.trim(),
  });

  function handle(message) {
    log(message);
    if (message.type === 'tournament.created') {
      $('tournamentId').value = message.tournament.id;
      return;
    }
    if (message.type === 'match.subscribed' || message.type === 'match.update') {
      latestMatch = message.match;
      latestState = message.state;
      $('matchId').value = message.match.id;
      renderState(message.state);
      return;
    }
    if (message.type === 'tournament.state') {
      const bracket = message.tournament.bracket || [];
      const match = bracket.find(candidate => candidate.status === 'active')
        || bracket.find(candidate => candidate.status === 'ready');
      if (match) $('matchId').value = match.id;
    }
  }

  function renderState(state) {
    if (!state) return;
    $('revision').textContent = state.request ? state.request.revision : '-';
    $('choices').replaceChildren();
    if (!state.request || !state.request.choices) return;
    for (const choice of state.request.choices) {
      const button = document.createElement('button');
      button.textContent = JSON.stringify(choice);
      button.onclick = () => send({
        type: 'match.choice',
        matchId: latestMatch.id,
        battleInstanceId: latestMatch.battleInstanceId,
        requestRevision: state.request.revision,
        choice: choice.type === 'move'
          ? { type: 'move', slot: choice.slot }
          : choice.type === 'switch'
            ? { type: 'switch', slot: choice.slot }
            : { type: choice.type },
      });
      $('choices').appendChild(button);
    }
  }
})();
