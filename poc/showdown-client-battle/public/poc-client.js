/* global Battle, BattleChoiceBuilder, POKEARENA_POC, $ */

(function () {
  const statusEl = document.getElementById('status');
  const choicePanel = document.getElementById('choice-panel');
  const createBtn = document.getElementById('create');
  const readyBtn = document.getElementById('ready');
  const startBtn = document.getElementById('start');

  const state = {
    socket: null,
    room: null,
    matchId: null,
    battleInstanceId: null,
    lastSequence: 0,
    requestRevision: null,
    battle: null,
    pending: new Map(),
  };

  function setStatus(text) {
    statusEl.textContent = text;
  }

  function request(message) {
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      state.pending.set(requestId, { resolve, reject });
      state.socket.send(JSON.stringify({ ...message, requestId }));
    });
  }

  function showdownChoiceToPlayerChoice(choiceText) {
    const normalized = choiceText.trim().toLowerCase().replace(/\s+/g, ' ');
    if (normalized === 'default' || normalized === 'team' || normalized.startsWith('team ')) {
      return { type: 'team-preview' };
    }
    if (normalized === 'pass') return { type: 'pass' };
    const move = normalized.match(/^move\s+(\d+)(?:\s+(-?\d+))?(.*)$/);
    if (move) {
      const choice = { type: 'move', slot: Number(move[1]) };
      if (move[2] !== undefined) choice.target = Number(move[2]);
      if (/\b(terastallize|terastal)\b/.test(normalized)) choice.terastallize = true;
      return choice;
    }
    const sw = normalized.match(/^switch\s+(\d+)$/);
    if (sw) return { type: 'switch', slot: Number(sw[1]) };
    throw new Error('Unsupported Showdown choice: ' + choiceText);
  }

  function eventsToFeed(events) {
    const publicLines = [];
    const requestPayloads = [];
    for (const event of events) {
      if (event.sequence <= state.lastSequence) continue;
      if (event.kind !== 'protocol') continue;
      for (const raw of String(event.data).split('\n')) {
        const line = raw.trimEnd();
        if (!line) continue;
        if (line.startsWith('|request|')) {
          if (event.scope !== 'private') continue;
          try {
            requestPayloads.push(JSON.parse(line.slice('|request|'.length)));
          } catch (_) {}
          continue;
        }
        if (event.scope === 'public') publicLines.push(line);
      }
      state.lastSequence = Math.max(state.lastSequence, event.sequence);
    }
    return { publicLines, requestPayloads };
  }

  function ensureBattle() {
    if (state.battle) return state.battle;
    state.battle = new Battle({
      id: 'pokearena-poc',
      $frame: $('.battle'),
      $logFrame: $('.battle-log'),
      log: [],
      paused: false,
      autoresize: true,
    });
    return state.battle;
  }

  function feedProtocol(events) {
    const battle = ensureBattle();
    const feed = eventsToFeed(events);
    for (const line of feed.publicLines) {
      battle.add(line);
    }
    if (feed.requestPayloads.length) {
      const requestPayload = feed.requestPayloads[feed.requestPayloads.length - 1];
      renderChoices(requestPayload);
    }
  }

  function renderChoices(requestPayload) {
    choicePanel.innerHTML = '';
    if (!requestPayload || requestPayload.wait) {
      setStatus('Waiting for opponent / next request…');
      return;
    }

    // Prefer Showdown's own request shaping helpers when available.
    let shaped = requestPayload;
    try {
      if (typeof BattleChoiceBuilder !== 'undefined' && BattleChoiceBuilder.fixRequest) {
        BattleChoiceBuilder.fixRequest(requestPayload, ensureBattle());
        shaped = requestPayload;
      }
    } catch (_) {}

    const builder = new BattleChoiceBuilder(shaped);
    state.requestRevision = ensureBattle()?.mySide ? (shaped.rqid || state.requestRevision) : state.requestRevision;

    // Pull revision from PokeArena typed state when present on last match update.
    const active = shaped.active && shaped.active[0];
    const moves = (active && active.moves) || [];
    moves.forEach((move, index) => {
      if (move.disabled) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = move.name + (move.pp != null ? ` (${move.pp}/${move.maxpp})` : '');
      button.onclick = () => void submitShowdownChoice(`move ${index + 1}`);
      choicePanel.appendChild(button);
    });

    if (active && active.canTerastallize) {
      const tera = document.createElement('button');
      tera.type = 'button';
      tera.textContent = 'Tera + move 1';
      tera.onclick = () => void submitShowdownChoice('move 1 terastallize');
      choicePanel.appendChild(tera);
    }

    const sidePokemon = (shaped.side && shaped.side.pokemon) || [];
    sidePokemon.forEach((pokemon, index) => {
      if (pokemon.active || String(pokemon.condition || '').endsWith(' fnt')) return;
      if (active && active.trapped) return;
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Switch ' + (pokemon.ident || pokemon.details || ('#' + (index + 1)));
      button.onclick = () => void submitShowdownChoice(`switch ${index + 1}`);
      choicePanel.appendChild(button);
    });

    if (shaped.teamPreview || shaped.requestType === 'team') {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Confirm team preview';
      button.onclick = () => void submitShowdownChoice('default');
      choicePanel.appendChild(button);
    }

    // Keep builder referenced so we prove Showdown choice parsing is reachable.
    void builder;
    setStatus('Select a Showdown move/switch (translated to typed PokeArena choice).');
  }

  async function submitShowdownChoice(choiceText) {
    if (!state.matchId || !state.battleInstanceId || state.requestRevision == null) {
      setStatus('No active request revision yet.');
      return;
    }
    const choice = showdownChoiceToPlayerChoice(choiceText);
    setStatus('Submitting typed choice via PokeArena API: ' + JSON.stringify(choice));
    choicePanel.innerHTML = '';
    try {
      await request({
        type: 'match.choice',
        matchId: state.matchId,
        battleInstanceId: state.battleInstanceId,
        requestRevision: state.requestRevision,
        choice,
      });
    } catch (error) {
      setStatus(String(error.message || error));
    }
  }

  function onMessage(message) {
    if (message.requestId && state.pending.has(message.requestId)) {
      const pending = state.pending.get(message.requestId);
      state.pending.delete(message.requestId);
      if (message.type === 'error') pending.reject(new Error(message.code + ': ' + message.message));
      else pending.resolve(message);
    }

    if (message.type === 'casual.state' || message.type === 'casual.created') {
      state.room = message.room;
      readyBtn.disabled = !(message.room.status === 'full' || message.room.status === 'ready');
      startBtn.disabled = !(message.room.opponentId && (message.room.status === 'full' || message.room.status === 'ready'));
      setStatus('Room ' + message.room.status + ' · opponent=' + (message.room.opponentId || 'waiting for bot'));
      if (message.room.status === 'battling') {
        void enterBattle(message.room);
      }
    }

    if (message.type === 'match.subscribed' || message.type === 'match.update') {
      state.matchId = message.match.id;
      state.battleInstanceId = message.match.battleInstanceId;
      if (message.state && message.state.request) {
        state.requestRevision = message.state.request.revision;
      }
      if (message.view && message.view.request) {
        state.requestRevision = message.view.request.revision;
      }
      feedProtocol(message.events || []);
      if (message.match.status === 'completed') {
        setStatus('Battle completed through Showdown renderer ← BattleEngine.');
        choicePanel.innerHTML = '';
      }
    }
  }

  async function enterBattle(room) {
    if (state.matchId === room.matchId && state.battle) return;
    state.matchId = room.matchId;
    state.battleInstanceId = room.battleInstanceId;
    state.lastSequence = 0;
    try {
      ensureBattle();
      setStatus('Subscribing to match ' + room.matchId);
      const subscribed = await request({ type: 'match.subscribe', matchId: room.matchId });
      onMessage(subscribed);
    } catch (error) {
      setStatus('Battle enter failed: ' + (error.message || error));
      console.error(error);
    }
  }

  createBtn.onclick = async () => {
    createBtn.disabled = true;
    setStatus('Creating open casual 1v1 room…');
    const created = await request({
      type: 'casual.create',
      roomType: 'open',
      battleSize: '1v1',
      collateral: 10_000,
    });
    state.room = created.room;
    setStatus('Room created. Waiting for demo-player-2 bot to accept…');
  };

  readyBtn.onclick = async () => {
    if (!state.room) return;
    await request({ type: 'casual.ready', roomId: state.room.id, ready: true });
  };

  startBtn.onclick = async () => {
    if (!state.room) return;
    const started = await request({ type: 'casual.start', roomId: state.room.id });
    onMessage(started);
  };

  function connect() {
    const socket = new WebSocket(POKEARENA_POC.wsUrl);
    state.socket = socket;
    socket.onopen = async () => {
      setStatus('Identifying as ' + POKEARENA_POC.playerId);
      await request({ type: 'identify', playerId: POKEARENA_POC.playerId });
      setStatus('Connected. Create a casual room to begin the Showdown renderer POC.');
    };
    socket.onmessage = event => {
      onMessage(JSON.parse(event.data));
    };
    socket.onclose = () => setStatus('Disconnected from PokeArena API.');
    socket.onerror = () => setStatus('WebSocket error talking to PokeArena API.');
  }

  connect();
})();
