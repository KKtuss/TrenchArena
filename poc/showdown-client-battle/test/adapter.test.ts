import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eventsToShowdownFeed,
  latestRequestPayload,
  showdownChoiceToPlayerChoice,
} from '../src/showdown-client-adapter';

test('eventsToShowdownFeed separates public protocol from private requests', () => {
  const feed = eventsToShowdownFeed([
    {
      sequence: 1,
      scope: 'public',
      kind: 'protocol',
      data: '|player|p1|demo-player-1\n|turn|1',
    },
    {
      sequence: 2,
      scope: 'private',
      playerId: 'demo-player-1',
      kind: 'protocol',
      data: '|request|{"active":[{"moves":[{"name":"Shadow Ball","id":"shadowball","pp":8,"maxpp":8,"target":"normal"}]}],"side":{"id":"p1","name":"demo-player-1","pokemon":[]}}',
    },
    {
      sequence: 3,
      scope: 'private',
      playerId: 'demo-player-2',
      kind: 'protocol',
      data: '|request|{"wait":true}',
    },
  ]);

  assert.deepEqual(feed.publicLines, ['|player|p1|demo-player-1', '|turn|1']);
  assert.equal(feed.requestPayloads.length, 2);
  assert.equal((feed.requestPayloads[0] as any).active[0].moves[0].name, 'Shadow Ball');
  assert.equal((latestRequestPayload(feed.requestPayloads) as any).wait, true);
});

test('showdownChoiceToPlayerChoice maps move/switch/tera/default/pass', () => {
  assert.deepEqual(showdownChoiceToPlayerChoice('move 1'), { type: 'move', slot: 1 });
  assert.deepEqual(showdownChoiceToPlayerChoice('move 2 1'), { type: 'move', slot: 2, target: 1 });
  assert.deepEqual(showdownChoiceToPlayerChoice('move 1 terastallize'), {
    type: 'move',
    slot: 1,
    terastallize: true,
  });
  assert.deepEqual(showdownChoiceToPlayerChoice('switch 4'), { type: 'switch', slot: 4 });
  assert.deepEqual(showdownChoiceToPlayerChoice('default'), { type: 'team-preview' });
  assert.deepEqual(showdownChoiceToPlayerChoice('pass'), { type: 'pass' });
  assert.throws(() => showdownChoiceToPlayerChoice('eval process.exit()'));
});

test('adapter ignores already-consumed sequences', () => {
  const feed = eventsToShowdownFeed([
    { sequence: 1, scope: 'public', kind: 'protocol', data: '|turn|1' },
    { sequence: 2, scope: 'public', kind: 'protocol', data: '|turn|2' },
  ], 1);
  assert.deepEqual(feed.publicLines, ['|turn|2']);
});
