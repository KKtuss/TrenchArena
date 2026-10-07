import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assessDeclaredProgramIds,
  assessStagingSigners,
} from './verify-staging-runtime.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(join(root, 'packages/solana-client/package.json'));
const { PublicKey } = require('@solana/web3.js');

const DEAD_PROGRAM = '6nVegJd8zVaV8RfLL6VQ6AQoB53FPsZSTGfidevdKM98';
const PRODUCTION_PROGRAM = '41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W';
const PROGRAM = PublicKey.unique().toBase58();
const DEPLOYER = PublicKey.unique().toBase58();
const AUTHORITY = PublicKey.unique().toBase58();
const KEEPER = PublicKey.unique().toBase58();

test('declared staging program IDs reject the retired and production programs', () => {
  const retired = assessDeclaredProgramIds({
    anchorId: DEAD_PROGRAM,
    declaredId: DEAD_PROGRAM,
    idlAddress: DEAD_PROGRAM,
    configuredId: DEAD_PROGRAM,
  });
  assert.match(retired.join('\n'), /retired staging program/);
  assert.doesNotMatch(retired.join('\n'), /do not match/);

  const production = assessDeclaredProgramIds({
    anchorId: PRODUCTION_PROGRAM,
    declaredId: PRODUCTION_PROGRAM,
    idlAddress: PRODUCTION_PROGRAM,
    configuredId: PRODUCTION_PROGRAM,
  });
  assert.match(production.join('\n'), /production program/);

  const fresh = assessDeclaredProgramIds({
    anchorId: PROGRAM,
    declaredId: PROGRAM,
    idlAddress: PROGRAM,
    configuredId: PROGRAM,
  });
  assert.deepEqual(fresh, []);
});

test('the four staging signers must be present, distinct, and new', () => {
  const missing = assessStagingSigners({
    programId: '',
    deployer: '',
    authority: '',
    keeper: '',
  });
  assert.match(missing.join('\n'), /program ID: NOT GENERATED/);
  assert.match(missing.join('\n'), /deployer: NOT GENERATED/);
  assert.match(missing.join('\n'), /config authority: NOT GENERATED/);
  assert.match(missing.join('\n'), /keeper: NOT GENERATED/);
  const fresh = assessStagingSigners({
    programId: PROGRAM,
    deployer: DEPLOYER,
    authority: AUTHORITY,
    keeper: KEEPER,
  });
  assert.deepEqual(fresh, []);

  const reused = assessStagingSigners({
    programId: PROGRAM,
    deployer: PROGRAM,
    authority: 'Bs919SY62WM6J22HZo1GPnSnxpL7B66JFXtjwCDC1fNJ',
    keeper: 'AZn8PqCeQLKyKLDUgy67NsvLtTiFzDY9S491fGC15iAL',
  });
  assert.match(reused.join('\n'), /distinct from the program ID/);
  assert.match(reused.join('\n'), /retired staging identity/);
  assert.match(reused.join('\n'), /production identity/);
});
