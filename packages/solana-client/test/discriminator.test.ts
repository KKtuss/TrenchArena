import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IX, anchorDiscriminator } from '../src/index';

test('anchor discriminators are stable 8-byte digests', () => {
  assert.equal(IX.initializeConfig.length, 8);
  assert.deepEqual(
    IX.initializeConfig,
    anchorDiscriminator('initialize_config'),
  );
  assert.notDeepEqual(IX.depositSolWager, IX.chargeMatchFee);
});
