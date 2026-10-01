import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  eventsToShowdownFeed,
  shouldCatchUpShowdownFeed,
  showdownChoiceToPlayerChoice,
} from '../lib/showdown-client-adapter';

test('feeds public protocol and only the viewer private request', () => {
  const feed = eventsToShowdownFeed([
    { sequence: 1, scope: 'public', kind: 'protocol', data: '|turn|1\n' },
    {
      sequence: 2,
      scope: 'private',
      playerId: 'demo-player-1',
      kind: 'protocol',
      data: '|request|{"requestType":"move","rqid":7}\n',
    },
    {
      sequence: 3,
      scope: 'private',
      playerId: 'demo-player-2',
      kind: 'protocol',
      data: '|request|{"requestType":"move","rqid":8}\n',
    },
  ], 0, 'demo-player-1');

  assert.deepEqual(feed.publicLines, ['|turn|1']);
  assert.deepEqual(feed.requestPayloads, [
    { requestType: 'move', rqid: 7 },
  ]);
  assert.equal(feed.lastSequence, 3);
});

test('skips consumed sequences and translates move/switch intents', () => {
  const feed = eventsToShowdownFeed([
    { sequence: 1, scope: 'public', kind: 'protocol', data: '|turn|1' },
    { sequence: 2, scope: 'public', kind: 'protocol', data: '|turn|2' },
  ], 1);

  assert.deepEqual(feed.publicLines, ['|turn|2']);
  assert.deepEqual(showdownChoiceToPlayerChoice('move 2 -1'), {
    type: 'move',
    slot: 2,
    target: -1,
  });
  assert.deepEqual(showdownChoiceToPlayerChoice('switch 4'), {
    type: 'switch',
    slot: 4,
  });
  assert.deepEqual(showdownChoiceToPlayerChoice('move 1 terastallize'), {
    type: 'move',
    slot: 1,
    terastallize: true,
  });
  assert.throws(() => showdownChoiceToPlayerChoice('>eval process.exit()'));
});

test('a progressed or finished log is caught up only on a fresh renderer', () => {
  assert.equal(shouldCatchUpShowdownFeed(0, ['|start|', '|turn|1', '|move|p1a: X|Tackle']), true);
  assert.equal(shouldCatchUpShowdownFeed(0, ['|start|', '|win|p1']), true);
  assert.equal(shouldCatchUpShowdownFeed(0, ['|start|', '|switch|p1a: X|X']), false);
  assert.equal(shouldCatchUpShowdownFeed(4, ['|turn|3']), false);
  assert.equal(shouldCatchUpShowdownFeed(0, [
    '|start|',
    '|switch|p1a: X|X, L100|100/100',
    '|switch|p2a: Y|Y, L100|100/100',
    '|turn|1',
  ]), false);
  assert.equal(shouldCatchUpShowdownFeed(0, [
    '|t:|1',
    '|start|',
    '|switch|p1a: X|X',
    '|turn|1',
    '|t:|2',
  ]), false);
  assert.equal(shouldCatchUpShowdownFeed(0, [
    '|start|',
    '|switch|p1a: X|X',
    '|turn|1',
    '|move|p1a: X|Tackle',
    '|turn|10',
  ]), true);
});
