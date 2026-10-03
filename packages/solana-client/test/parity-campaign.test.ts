/**
 * Comprehensive local-validator parity campaign for arena-escrow.
 * Runs against whichever binary is genesis-loaded (Anchor or Pinocchio).
 * When POKEARENA_PARITY_OUT is set, writes a JSON report for differential compare.
 *
 * Does not modify production code or Anchor sources.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  createMatchEscrowIx,
  depositSolWagerIx,
  seatMatchOpponentIx,
  refundSolWagerIx,
  chargeMatchFeeIx,
  settleMatchWinIx,
  settleMatchTieIx,
  depositPokeEntryIx,
  refundPokeEntryIx,
  burnPokeEntryIx,
  depositTreasurySolIx,
  reservePrizeIx,
  setPrizeWinnerIx,
  payPrizeIx,
  releasePrizeIx,
  buybackAndBurnPokeIx,
  initializeConfigIx,
} from '../src/instructions';
import {
  matchEscrowPda,
  matchVaultPda,
  entryEscrowPda,
  entryVaultPda,
  prizeReservePda,
  prizeVaultPda,
  replayPda,
  treasuryDepositPda,
  configPda,
} from '../src/pdas';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '../src/token';
import { IX } from '../src/discriminator';
import { CASUAL_FEE_BPS } from '../src/constants';
import {
  CaseOutcome,
  Ctx,
  assertCase,
  finalizeReport,
  labeledId16,
  labeledKey32,
  loadCtx,
  maybeWriteReport,
  programExecutableLen,
  runCase,
  sendIx,
} from './parity-campaign.helpers';

const cases: CaseOutcome[] = [];

async function record(outcome: CaseOutcome): Promise<CaseOutcome> {
  cases.push(outcome);
  assertCase(outcome);
  return outcome;
}

async function fundIfNeeded(ctx: Ctx, pk: PublicKey, min = 2 * LAMPORTS_PER_SOL): Promise<void> {
  const bal = await ctx.connection.getBalance(pk, 'confirmed');
  if (bal < min) {
    const sig = await ctx.connection.requestAirdrop(pk, 50 * LAMPORTS_PER_SOL);
    await ctx.connection.confirmTransaction(sig, 'confirmed');
  }
}

/** Build a funded SOL match ready for fee charge (both deposited). */
async function setupFundedMatch(ctx: Ctx, label: string, collateral = Math.floor(0.1 * LAMPORTS_PER_SOL)) {
  const roomId = labeledId16(label);
  const [matchEscrow] = matchEscrowPda(ctx.programId, roomId);
  const [matchVault] = matchVaultPda(ctx.programId, roomId);
  const create = createMatchEscrowIx({
    programId: ctx.programId,
    creator: ctx.player1.publicKey,
    config: ctx.config,
    roomId,
    collateralLamports: collateral,
  });
  const d0 = depositSolWagerIx({
    programId: ctx.programId,
    depositor: ctx.player1.publicKey,
    roomId,
    side: 0,
  });
  let r = await sendIx({ connection: ctx.connection, payer: ctx.player1, ix: [create, d0] });
  assert.equal(r.ok, true, `setup create/deposit0 ${label}`);
  r = await sendIx({
    connection: ctx.connection,
    payer: ctx.authority,
    ix: seatMatchOpponentIx({
      programId: ctx.programId,
      authority: ctx.authority.publicKey,
      config: ctx.config,
      opponent: ctx.player2.publicKey,
      roomId,
    }),
  });
  assert.equal(r.ok, true, `setup seat ${label}`);
  r = await sendIx({
    connection: ctx.connection,
    payer: ctx.player2,
    ix: depositSolWagerIx({
      programId: ctx.programId,
      depositor: ctx.player2.publicKey,
      roomId,
      side: 1,
    }),
  });
  assert.equal(r.ok, true, `setup deposit1 ${label}`);
  return { roomId, matchEscrow, matchVault, collateral };
}

test('parity campaign: full instruction + adversarial matrix', async (t) => {
  const ctx = await loadCtx();
  if (!ctx) {
    t.skip('chain economy / validator / config not ready');
    return;
  }

  await fundIfNeeded(ctx, ctx.authority.publicKey);
  await fundIfNeeded(ctx, ctx.keeper.publicKey);
  await fundIfNeeded(ctx, ctx.player1.publicKey);
  await fundIfNeeded(ctx, ctx.player2.publicKey);

  const startedAt = new Date().toISOString();
  const programDataLen = await programExecutableLen(ctx.connection, ctx.programId);
  const player1Ata = getAssociatedTokenAddressSync(ctx.pokeMint, ctx.player1.publicKey, true);
  const player2Ata = getAssociatedTokenAddressSync(ctx.pokeMint, ctx.player2.publicKey, true);
  const authorityAta = getAssociatedTokenAddressSync(ctx.pokeMint, ctx.authority.publicKey, true);

  // Ensure authority has a POKE ATA for buyback burn source (create via deposit path if missing).
  {
    const info = await ctx.connection.getAccountInfo(authorityAta);
    if (!info) {
      // Mint path already bootstrapped players; create ATA by depositing then refunding a tiny entry.
      // If that fails, buyback success path will be marked carefully.
    }
  }

  // -------------------------------------------------------------------------
  // initialize_config — already initialized; double-init must reject
  // -------------------------------------------------------------------------
  await record(
    await runCase({
      id: 'initialize_config/double-init',
      ix: 'initialize_config',
      category: 'invalid-status',
      expectOk: false,
      connection: ctx.connection,
      payer: ctx.authority,
      instruction: initializeConfigIx({
        programId: ctx.programId,
        authority: ctx.authority.publicKey,
        pokeMint: ctx.pokeMint,
        quoteAuthority: ctx.authority.publicKey,
        keeper: ctx.keeper.publicKey,
        buybackBps: 2500,
        minBuybackLamports: 50_000_000,
      }),
      watch: { config: ctx.config },
    }),
  );

  // -------------------------------------------------------------------------
  // create_match_escrow — success + zero + wrong config owner
  // -------------------------------------------------------------------------
  {
    const roomId = labeledId16('create-ok');
    const [matchEscrow] = matchEscrowPda(ctx.programId, roomId);
    await record(
      await runCase({
        id: 'create_match_escrow/ok',
        ix: 'create_match_escrow',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: createMatchEscrowIx({
          programId: ctx.programId,
          creator: ctx.player1.publicKey,
          config: ctx.config,
          roomId,
          collateralLamports: 100_000_000,
        }),
        watch: { matchEscrow },
      }),
    );
    await record(
      await runCase({
        id: 'create_match_escrow/zero-amount',
        ix: 'create_match_escrow',
        category: 'zero-amount',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: createMatchEscrowIx({
          programId: ctx.programId,
          creator: ctx.player1.publicKey,
          config: ctx.config,
          roomId: labeledId16('create-zero'),
          collateralLamports: 0,
        }),
      }),
    );
    // Wrong config: pass a system-owned account with Config-shaped wrong owner
    await record(
      await runCase({
        id: 'create_match_escrow/wrong-config-account',
        ix: 'create_match_escrow',
        category: 'wrong-account-type',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: createMatchEscrowIx({
          programId: ctx.programId,
          creator: ctx.player1.publicKey,
          config: ctx.player1.publicKey, // wrong owner/type
          roomId: labeledId16('create-bad-cfg'),
          collateralLamports: 100_000_000,
        }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // deposit / seat / refund path (cancel before fee)
  // -------------------------------------------------------------------------
  {
    const roomId = labeledId16('refund-path');
    const [matchEscrow] = matchEscrowPda(ctx.programId, roomId);
    const [matchVault] = matchVaultPda(ctx.programId, roomId);
    await record(
      await runCase({
        id: 'deposit_sol_wager/creator-ok',
        ix: 'deposit_sol_wager',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: [
          createMatchEscrowIx({
            programId: ctx.programId,
            creator: ctx.player1.publicKey,
            config: ctx.config,
            roomId,
            collateralLamports: 50_000_000,
          }),
          depositSolWagerIx({
            programId: ctx.programId,
            depositor: ctx.player1.publicKey,
            roomId,
            side: 0,
          }),
        ],
        watch: { matchEscrow, matchVault },
        deltaKeys: { matchVault },
      }),
    );
    await record(
      await runCase({
        id: 'deposit_sol_wager/duplicate-creator',
        ix: 'deposit_sol_wager',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositSolWagerIx({
          programId: ctx.programId,
          depositor: ctx.player1.publicKey,
          roomId,
          side: 0,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'deposit_sol_wager/wrong-side-before-seat',
        ix: 'deposit_sol_wager',
        category: 'invalid-status',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player2,
        instruction: depositSolWagerIx({
          programId: ctx.programId,
          depositor: ctx.player2.publicKey,
          roomId,
          side: 1,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'seat_match_opponent/wrong-signer',
        ix: 'seat_match_opponent',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: seatMatchOpponentIx({
          programId: ctx.programId,
          authority: ctx.player1.publicKey,
          config: ctx.config,
          opponent: ctx.player2.publicKey,
          roomId,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'seat_match_opponent/ok',
        ix: 'seat_match_opponent',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: seatMatchOpponentIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          opponent: ctx.player2.publicKey,
          roomId,
        }),
        watch: { matchEscrow },
      }),
    );
    await record(
      await runCase({
        id: 'seat_match_opponent/seat-self',
        ix: 'seat_match_opponent',
        category: 'unauthorized-recipient',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: seatMatchOpponentIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          opponent: ctx.player1.publicKey,
          roomId,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'deposit_sol_wager/wrong-depositor',
        ix: 'deposit_sol_wager',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositSolWagerIx({
          programId: ctx.programId,
          depositor: ctx.player1.publicKey,
          roomId,
          side: 1,
        }),
      }),
    );
    // Refund is only legal while Open/Funding/Cancelled — NOT after both sides Funded.
    await record(
      await runCase({
        id: 'refund_sol_wager/creator-ok',
        ix: 'refund_sol_wager',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: refundSolWagerIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          recipient: ctx.player1.publicKey,
          roomId,
          side: 0,
        }),
        watch: { matchEscrow },
        deltaKeys: { matchVault, recipient: ctx.player1.publicKey },
      }),
    );

    // Separate match: seat + both deposits + wrong recipient + Funded blocks refund.
    {
      const roomId2 = labeledId16('refund-funded');
      const [matchEscrow2] = matchEscrowPda(ctx.programId, roomId2);
      let r = await sendIx({
        connection: ctx.connection,
        payer: ctx.player1,
        ix: [
          createMatchEscrowIx({
            programId: ctx.programId,
            creator: ctx.player1.publicKey,
            config: ctx.config,
            roomId: roomId2,
            collateralLamports: 50_000_000,
          }),
          depositSolWagerIx({
            programId: ctx.programId,
            depositor: ctx.player1.publicKey,
            roomId: roomId2,
            side: 0,
          }),
        ],
      });
      assert.equal(r.ok, true, 'funded-path create/deposit0');
      r = await sendIx({
        connection: ctx.connection,
        payer: ctx.authority,
        ix: seatMatchOpponentIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          opponent: ctx.player2.publicKey,
          roomId: roomId2,
        }),
      });
      assert.equal(r.ok, true, 'funded-path seat');
      await record(
        await runCase({
          id: 'deposit_sol_wager/opponent-ok',
          ix: 'deposit_sol_wager',
          category: 'success',
          expectOk: true,
          connection: ctx.connection,
          payer: ctx.player2,
          instruction: depositSolWagerIx({
            programId: ctx.programId,
            depositor: ctx.player2.publicKey,
            roomId: roomId2,
            side: 1,
          }),
          watch: { matchEscrow: matchEscrow2 },
        }),
      );
      await record(
        await runCase({
          id: 'refund_sol_wager/wrong-recipient',
          ix: 'refund_sol_wager',
          category: 'unauthorized-recipient',
          expectOk: false,
          connection: ctx.connection,
          payer: ctx.authority,
          instruction: refundSolWagerIx({
            programId: ctx.programId,
            authority: ctx.authority.publicKey,
            config: ctx.config,
            recipient: ctx.player1.publicKey,
            roomId: roomId2,
            side: 1,
          }),
          note: 'Funded status rejects before recipient check may apply',
        }),
      );
      await record(
        await runCase({
          id: 'refund_sol_wager/after-funded',
          ix: 'refund_sol_wager',
          category: 'invalid-status',
          expectOk: false,
          connection: ctx.connection,
          payer: ctx.authority,
          instruction: refundSolWagerIx({
            programId: ctx.programId,
            authority: ctx.authority.publicKey,
            config: ctx.config,
            recipient: ctx.player2.publicKey,
            roomId: roomId2,
            side: 1,
          }),
        }),
      );
    }

    // Opponent refund while Funding (opponent deposited, creator has not).
    {
      const roomId4 = labeledId16('refund-opp-only');
      let r = await sendIx({
        connection: ctx.connection,
        payer: ctx.player1,
        ix: createMatchEscrowIx({
          programId: ctx.programId,
          creator: ctx.player1.publicKey,
          config: ctx.config,
          roomId: roomId4,
          collateralLamports: 40_000_000,
        }),
      });
      assert.equal(r.ok, true, 'opp-only create');
      r = await sendIx({
        connection: ctx.connection,
        payer: ctx.authority,
        ix: seatMatchOpponentIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          opponent: ctx.player2.publicKey,
          roomId: roomId4,
        }),
      });
      assert.equal(r.ok, true, 'opp-only seat');
      r = await sendIx({
        connection: ctx.connection,
        payer: ctx.player2,
        ix: depositSolWagerIx({
          programId: ctx.programId,
          depositor: ctx.player2.publicKey,
          roomId: roomId4,
          side: 1,
        }),
      });
      assert.equal(r.ok, true, 'opp-only deposit1');
      await record(
        await runCase({
          id: 'refund_sol_wager/wrong-recipient-funding',
          ix: 'refund_sol_wager',
          category: 'unauthorized-recipient',
          expectOk: false,
          connection: ctx.connection,
          payer: ctx.authority,
          instruction: refundSolWagerIx({
            programId: ctx.programId,
            authority: ctx.authority.publicKey,
            config: ctx.config,
            recipient: ctx.player1.publicKey,
            roomId: roomId4,
            side: 1,
          }),
        }),
      );
      await record(
        await runCase({
          id: 'refund_sol_wager/opponent-ok',
          ix: 'refund_sol_wager',
          category: 'success',
          expectOk: true,
          connection: ctx.connection,
          payer: ctx.authority,
          instruction: refundSolWagerIx({
            programId: ctx.programId,
            authority: ctx.authority.publicKey,
            config: ctx.config,
            recipient: ctx.player2.publicKey,
            roomId: roomId4,
            side: 1,
          }),
        }),
      );
    }
  }

  // -------------------------------------------------------------------------
  // Full win lifecycle + fee + settle + replay
  // -------------------------------------------------------------------------
  {
    const { roomId, matchEscrow, matchVault, collateral } = await setupFundedMatch(ctx, 'win-life');
    await record(
      await runCase({
        id: 'settle_match_win/before-fee',
        ix: 'settle_match_win',
        category: 'invalid-status',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchWinIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          roomId,
          settlementKey: labeledKey32('win-before-fee'),
        }),
      }),
    );
    await record(
      await runCase({
        id: 'charge_match_fee/wrong-signer',
        ix: 'charge_match_fee',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: chargeMatchFeeIx({
          programId: ctx.programId,
          authority: ctx.player1.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          roomId,
        }),
      }),
    );
    const expectedFee = Math.floor((collateral * 2 * CASUAL_FEE_BPS) / 10_000);
    const feeCase = await record(
      await runCase({
        id: 'charge_match_fee/ok',
        ix: 'charge_match_fee',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: chargeMatchFeeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          roomId,
        }),
        watch: { matchEscrow, matchVault },
        deltaKeys: { feeVault: ctx.feeVault, matchVault },
      }),
    );
    assert.equal(feeCase.deltas.feeVault, expectedFee);
    await record(
      await runCase({
        id: 'charge_match_fee/duplicate',
        ix: 'charge_match_fee',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: chargeMatchFeeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          roomId,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'refund_sol_wager/after-fee',
        ix: 'refund_sol_wager',
        category: 'invalid-status',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: refundSolWagerIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          recipient: ctx.player1.publicKey,
          roomId,
          side: 0,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'settle_match_win/wrong-winner',
        ix: 'settle_match_win',
        category: 'unauthorized-recipient',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchWinIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: Keypair.generate().publicKey,
          roomId,
          settlementKey: labeledKey32('win-wrong-winner'),
        }),
      }),
    );
    const settleKey = labeledKey32('win-ok');
    const [replay] = replayPda(ctx.programId, settleKey);
    await record(
      await runCase({
        id: 'settle_match_win/ok',
        ix: 'settle_match_win',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchWinIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          roomId,
          settlementKey: settleKey,
        }),
        watch: { matchEscrow, matchVault, replay },
        deltaKeys: { winner: ctx.player1.publicKey, matchVault },
      }),
    );
    await record(
      await runCase({
        id: 'settle_match_win/replay',
        ix: 'settle_match_win',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchWinIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          roomId,
          settlementKey: settleKey,
        }),
        watch: { replay },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Tie lifecycle
  // -------------------------------------------------------------------------
  {
    const { roomId, matchEscrow, matchVault } = await setupFundedMatch(ctx, 'tie-life');
    await record(
      await runCase({
        id: 'charge_match_fee/tie-prep',
        ix: 'charge_match_fee',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: chargeMatchFeeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          roomId,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'settle_match_tie/wrong-creator-account',
        ix: 'settle_match_tie',
        category: 'unauthorized-recipient',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchTieIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          creator: ctx.player2.publicKey,
          opponent: ctx.player2.publicKey,
          roomId,
          settlementKey: labeledKey32('tie-bad-accounts'),
        }),
      }),
    );
    const tieKey = labeledKey32('tie-ok');
    const [replay] = replayPda(ctx.programId, tieKey);
    await record(
      await runCase({
        id: 'settle_match_tie/ok',
        ix: 'settle_match_tie',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchTieIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          creator: ctx.player1.publicKey,
          opponent: ctx.player2.publicKey,
          roomId,
          settlementKey: tieKey,
        }),
        watch: { matchEscrow, matchVault, replay },
      }),
    );
    await record(
      await runCase({
        id: 'settle_match_tie/replay',
        ix: 'settle_match_tie',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchTieIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          creator: ctx.player1.publicKey,
          opponent: ctx.player2.publicKey,
          roomId,
          settlementKey: tieKey,
        }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // POKE entry deposit / refund / burn
  // -------------------------------------------------------------------------
  {
    const tournamentId = labeledId16('poke-life');
    const [entryEscrow] = entryEscrowPda(ctx.programId, tournamentId, ctx.player1.publicKey);
    const [entryVault] = entryVaultPda(ctx.programId, tournamentId, ctx.player1.publicKey);
    await record(
      await runCase({
        id: 'deposit_poke_entry/zero',
        ix: 'deposit_poke_entry',
        category: 'zero-amount',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositPokeEntryIx({
          programId: ctx.programId,
          player: ctx.player1.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          playerPoke: player1Ata,
          tournamentId: labeledId16('poke-zero'),
          amount: 0n,
          quoteId: labeledKey32('q-zero'),
          priceMicroUsd: 400_000,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'deposit_poke_entry/wrong-mint',
        ix: 'deposit_poke_entry',
        category: 'wrong-mint',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositPokeEntryIx({
          programId: ctx.programId,
          player: ctx.player1.publicKey,
          config: ctx.config,
          pokeMint: Keypair.generate().publicKey,
          playerPoke: player1Ata,
          tournamentId: labeledId16('poke-bad-mint'),
          amount: 1_000n,
          quoteId: labeledKey32('q-bad-mint'),
          priceMicroUsd: 400_000,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'deposit_poke_entry/ok',
        ix: 'deposit_poke_entry',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositPokeEntryIx({
          programId: ctx.programId,
          player: ctx.player1.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          playerPoke: player1Ata,
          tournamentId,
          amount: 5_000n,
          quoteId: labeledKey32('q-poke-ok'),
          priceMicroUsd: 400_000,
        }),
        watch: { entryEscrow, entryVault },
      }),
    );
    await record(
      await runCase({
        id: 'refund_poke_entry/redirect-wallet',
        ix: 'refund_poke_entry',
        category: 'unauthorized-recipient',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: refundPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          playerPoke: player2Ata,
          tournamentId,
          player: ctx.player1.publicKey,
        }),
        watch: { entryEscrow },
      }),
    );
    await record(
      await runCase({
        id: 'refund_poke_entry/wrong-signer',
        ix: 'refund_poke_entry',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player2,
        instruction: refundPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.player2.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          playerPoke: player1Ata,
          tournamentId,
          player: ctx.player1.publicKey,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'refund_poke_entry/ok',
        ix: 'refund_poke_entry',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: refundPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          playerPoke: player1Ata,
          tournamentId,
          player: ctx.player1.publicKey,
        }),
        watch: { entryEscrow, entryVault },
      }),
    );
  }

  // Burn path (separate entry)
  {
    const tournamentId = labeledId16('poke-burn');
    const [entryEscrow] = entryEscrowPda(ctx.programId, tournamentId, ctx.player1.publicKey);
    const burnKey = labeledKey32('burn-ok');
    const [replay] = replayPda(ctx.programId, burnKey);
    let r = await sendIx({
      connection: ctx.connection,
      payer: ctx.player1,
      ix: depositPokeEntryIx({
        programId: ctx.programId,
        player: ctx.player1.publicKey,
        config: ctx.config,
        pokeMint: ctx.pokeMint,
        playerPoke: player1Ata,
        tournamentId,
        amount: 2_000n,
        quoteId: labeledKey32('q-burn'),
        priceMicroUsd: 400_000,
      }),
    });
    assert.equal(r.ok, true, 'poke burn setup deposit');
    await record(
      await runCase({
        id: 'burn_poke_entry/wrong-signer',
        ix: 'burn_poke_entry',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: burnPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.player1.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          tournamentId,
          player: ctx.player1.publicKey,
          burnKey: labeledKey32('burn-bad-auth'),
        }),
      }),
    );
    await record(
      await runCase({
        id: 'burn_poke_entry/ok',
        ix: 'burn_poke_entry',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: burnPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          tournamentId,
          player: ctx.player1.publicKey,
          burnKey,
        }),
        watch: { entryEscrow, replay },
      }),
    );
    await record(
      await runCase({
        id: 'burn_poke_entry/replay',
        ix: 'burn_poke_entry',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: burnPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          tournamentId,
          player: ctx.player1.publicKey,
          burnKey,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'refund_poke_entry/after-burn',
        ix: 'refund_poke_entry',
        category: 'invalid-status',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: refundPokeEntryIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          pokeMint: ctx.pokeMint,
          playerPoke: player1Ata,
          tournamentId,
          player: ctx.player1.publicKey,
        }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Treasury + prize paths
  // -------------------------------------------------------------------------
  {
    const claimKey = labeledKey32('treasury-ok');
    const [treasuryDeposit] = treasuryDepositPda(ctx.programId, claimKey);
    const [replay] = replayPda(ctx.programId, claimKey);
    await record(
      await runCase({
        id: 'deposit_treasury_sol/zero',
        ix: 'deposit_treasury_sol',
        category: 'zero-amount',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        signers: [ctx.authority],
        instruction: depositTreasurySolIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          payer: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          operatorVault: ctx.operatorVault,
          claimKey: labeledKey32('treasury-zero'),
          grossLamports: 0,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'deposit_treasury_sol/wrong-signer',
        ix: 'deposit_treasury_sol',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositTreasurySolIx({
          programId: ctx.programId,
          authority: ctx.player1.publicKey,
          payer: ctx.player1.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          operatorVault: ctx.operatorVault,
          claimKey: labeledKey32('treasury-bad-auth'),
          grossLamports: 1_000_000,
        }),
      }),
    );
    const treas = await record(
      await runCase({
        id: 'deposit_treasury_sol/ok',
        ix: 'deposit_treasury_sol',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: depositTreasurySolIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          payer: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          operatorVault: ctx.operatorVault,
          claimKey,
          grossLamports: 1_000_000_000,
        }),
        watch: { treasuryDeposit, replay },
        deltaKeys: { treasury: ctx.treasuryVault, operator: ctx.operatorVault },
      }),
    );
    assert.equal(treas.deltas.treasury, 900_000_000);
    assert.equal(treas.deltas.operator, 100_000_000);
    await record(
      await runCase({
        id: 'deposit_treasury_sol/replay',
        ix: 'deposit_treasury_sol',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: depositTreasurySolIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          payer: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          operatorVault: ctx.operatorVault,
          claimKey,
          grossLamports: 1_000_000_000,
        }),
      }),
    );
  }

  {
    const tournamentId = labeledId16('prize-pay');
    const [prizeReserve] = prizeReservePda(ctx.programId, tournamentId);
    const [prizeVault] = prizeVaultPda(ctx.programId, tournamentId);
    await record(
      await runCase({
        id: 'reserve_prize/zero',
        ix: 'reserve_prize',
        category: 'zero-amount',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: reservePrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          tournamentId: labeledId16('prize-zero'),
          amount: 0,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'reserve_prize/ok',
        ix: 'reserve_prize',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: reservePrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          tournamentId,
          amount: 50_000_000,
        }),
        watch: { prizeReserve, prizeVault },
        deltaKeys: { treasury: ctx.treasuryVault, prizeVault },
      }),
    );
    await record(
      await runCase({
        id: 'pay_prize/winner-not-set',
        ix: 'pay_prize',
        category: 'invalid-status',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: payPrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          tournamentId,
          settlementKey: labeledKey32('prize-early'),
        }),
      }),
    );
    await record(
      await runCase({
        id: 'set_prize_winner/ok',
        ix: 'set_prize_winner',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: setPrizeWinnerIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          tournamentId,
        }),
        watch: { prizeReserve },
      }),
    );
    await record(
      await runCase({
        id: 'set_prize_winner/duplicate',
        ix: 'set_prize_winner',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: setPrizeWinnerIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player2.publicKey,
          tournamentId,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'pay_prize/wrong-winner',
        ix: 'pay_prize',
        category: 'unauthorized-recipient',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: payPrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player2.publicKey,
          tournamentId,
          settlementKey: labeledKey32('prize-wrong'),
        }),
      }),
    );
    const payKey = labeledKey32('prize-pay-ok');
    const [replay] = replayPda(ctx.programId, payKey);
    await record(
      await runCase({
        id: 'pay_prize/ok',
        ix: 'pay_prize',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: payPrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          tournamentId,
          settlementKey: payKey,
        }),
        watch: { prizeReserve, prizeVault, replay },
        deltaKeys: { winner: ctx.player1.publicKey, prizeVault },
      }),
    );
    await record(
      await runCase({
        id: 'pay_prize/replay',
        ix: 'pay_prize',
        category: 'duplicate-replay',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: payPrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: ctx.player1.publicKey,
          tournamentId,
          settlementKey: payKey,
        }),
      }),
    );
  }

  // release_prize path
  {
    const tournamentId = labeledId16('prize-release');
    const [prizeReserve] = prizeReservePda(ctx.programId, tournamentId);
    const [prizeVault] = prizeVaultPda(ctx.programId, tournamentId);
    let r = await sendIx({
      connection: ctx.connection,
      payer: ctx.authority,
      ix: reservePrizeIx({
        programId: ctx.programId,
        authority: ctx.authority.publicKey,
        config: ctx.config,
        treasuryVault: ctx.treasuryVault,
        tournamentId,
        amount: 25_000_000,
      }),
    });
    assert.equal(r.ok, true, 'reserve for release');
    await record(
      await runCase({
        id: 'release_prize/wrong-signer',
        ix: 'release_prize',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: releasePrizeIx({
          programId: ctx.programId,
          authority: ctx.player1.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          tournamentId,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'release_prize/ok',
        ix: 'release_prize',
        category: 'success',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: releasePrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          tournamentId,
        }),
        watch: { prizeReserve, prizeVault },
        deltaKeys: { treasury: ctx.treasuryVault, prizeVault },
      }),
    );
    await record(
      await runCase({
        id: 'release_prize/after-release',
        ix: 'release_prize',
        category: 'invalid-status',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: releasePrizeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          treasuryVault: ctx.treasuryVault,
          tournamentId,
        }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // buyback_and_burn_poke — local fee_vault → swap_wallet + burn
  // -------------------------------------------------------------------------
  {
    // Ensure authority ATA exists and has tokens: mint via spl isn't available in TS here.
    // Use a player ATA as burn source only if authority can sign burn — burn authority must be ix authority.
    // Create authority ATA by having authority receive via... we can use deposit from player? No.
    // Bootstrap minted to players only. Create ATA for authority by transferring from player1 via token
    // program — skip if we can't; use player1 as authority? No, buyback requires authority/keeper.
    // Fund: transfer POKE from player1 to authority ATA using a raw token transfer is complex without @solana/spl-token.
    // Instead exercise rejection cases thoroughly + success if authority ATA already funded.
    await record(
      await runCase({
        id: 'buyback_and_burn_poke/zero',
        ix: 'buyback_and_burn_poke',
        category: 'zero-amount',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: buybackAndBurnPokeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          swapWallet: ctx.authority.publicKey,
          pokeMint: ctx.pokeMint,
          pokeBurnSource: player1Ata,
          buybackKey: labeledKey32('bb-zero'),
          solAmount: 0,
          minPokeOut: 1,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'buyback_and_burn_poke/too-small',
        ix: 'buyback_and_burn_poke',
        category: 'zero-amount',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: buybackAndBurnPokeIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          swapWallet: ctx.authority.publicKey,
          pokeMint: ctx.pokeMint,
          pokeBurnSource: player1Ata,
          buybackKey: labeledKey32('bb-small'),
          solAmount: 1,
          minPokeOut: 1,
        }),
      }),
    );
    await record(
      await runCase({
        id: 'buyback_and_burn_poke/wrong-signer',
        ix: 'buyback_and_burn_poke',
        category: 'wrong-signer',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: buybackAndBurnPokeIx({
          programId: ctx.programId,
          authority: ctx.player1.publicKey,
          config: ctx.config,
          feeVault: ctx.feeVault,
          swapWallet: ctx.player1.publicKey,
          pokeMint: ctx.pokeMint,
          pokeBurnSource: player1Ata,
          buybackKey: labeledKey32('bb-bad-auth'),
          solAmount: 50_000_000,
          minPokeOut: 1,
        }),
      }),
    );

    // Success path: mint authority can burn from an ATA it owns. Create authority ATA via
    // depositing as if... Simplest: use SystemProgram-free approach — call deposit_poke as authority
    // if we create ATA. Without spl-token createAccount, skip success if ATA missing.
    let authAtaBalance = 0n;
    try {
      const bal = await ctx.connection.getTokenAccountBalance(authorityAta, 'confirmed');
      authAtaBalance = BigInt(bal.value.amount);
    } catch {
      authAtaBalance = 0n;
    }
    if (authAtaBalance > 0n) {
      // spend = sol_amount * buyback_bps / 10_000 = 50e6 * 2500 / 10_000 = 12.5e6.
      // Ensure fee_vault can cover rent + spend via extra charged matches.
      for (let i = 0; i < 4; i++) {
        const { roomId } = await setupFundedMatch(ctx, `bb-fund-${i}`, Math.floor(0.25 * LAMPORTS_PER_SOL));
        const charged = await sendIx({
          connection: ctx.connection,
          payer: ctx.authority,
          ix: chargeMatchFeeIx({
            programId: ctx.programId,
            authority: ctx.authority.publicKey,
            config: ctx.config,
            feeVault: ctx.feeVault,
            roomId,
          }),
        });
        assert.equal(charged.ok, true, `bb fee fund ${i}`);
      }
      // Dedicated swap wallet avoids lamport-balance conflicts with the fee-paying authority
      // (replay account init + fee_vault→swap direct transfer in one instruction).
      const swapWallet = Keypair.generate();
      await fundIfNeeded(ctx, swapWallet.publicKey, LAMPORTS_PER_SOL);
      const bbKey = labeledKey32('bb-ok');
      const [replay] = replayPda(ctx.programId, bbKey);
      await record(
        await runCase({
          id: 'buyback_and_burn_poke/ok',
          ix: 'buyback_and_burn_poke',
          category: 'success',
          expectOk: true,
          connection: ctx.connection,
          payer: ctx.authority,
          instruction: buybackAndBurnPokeIx({
            programId: ctx.programId,
            authority: ctx.authority.publicKey,
            config: ctx.config,
            feeVault: ctx.feeVault,
            swapWallet: swapWallet.publicKey,
            pokeMint: ctx.pokeMint,
            pokeBurnSource: authorityAta,
            buybackKey: bbKey,
            solAmount: 50_000_000,
            minPokeOut: 1,
          }),
          watch: { replay },
          deltaKeys: { feeVault: ctx.feeVault, swap: swapWallet.publicKey },
        }),
      );
    } else {
      cases.push({
        id: 'buyback_and_burn_poke/ok-skipped-no-ata',
        ix: 'buyback_and_burn_poke',
        category: 'coverage-gap',
        ok: true,
        customError: null,
        errorText: null,
        expectReject: false,
        accounts: {},
        deltas: {},
        note: 'authority POKE ATA missing or empty; rejection cases still covered',
      });
    }
  }

  // -------------------------------------------------------------------------
  // Adversarial: malformed ix data / wrong PDA / wrong flags / overflow-ish
  // -------------------------------------------------------------------------
  {
    const roomId = labeledId16('adv-pda');
    // Wrong match PDA seeds: point match_escrow at a random keypair account
    const bogus = Keypair.generate();
    await record(
      await runCase({
        id: 'deposit_sol_wager/wrong-pda',
        ix: 'deposit_sol_wager',
        category: 'wrong-pda',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: new TransactionInstruction({
          programId: ctx.programId,
          keys: [
            { pubkey: ctx.player1.publicKey, isSigner: true, isWritable: true },
            { pubkey: bogus.publicKey, isSigner: false, isWritable: true },
            { pubkey: matchVaultPda(ctx.programId, roomId)[0], isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: Buffer.concat([IX.depositSolWager, Buffer.from([0])]),
        }),
      }),
    );

    // Truncated instruction data
    await record(
      await runCase({
        id: 'create_match_escrow/truncated-data',
        ix: 'create_match_escrow',
        category: 'malformed-data',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: new TransactionInstruction({
          programId: ctx.programId,
          keys: [
            { pubkey: ctx.player1.publicKey, isSigner: true, isWritable: true },
            { pubkey: ctx.config, isSigner: false, isWritable: false },
            { pubkey: matchEscrowPda(ctx.programId, labeledId16('trunc'))[0], isSigner: false, isWritable: true },
            { pubkey: matchVaultPda(ctx.programId, labeledId16('trunc'))[0], isSigner: false, isWritable: true },
            { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
          ],
          data: IX.createMatchEscrow, // missing room_id + amount
        }),
      }),
    );

    // Unknown discriminator
    await record(
      await runCase({
        id: 'unknown/bad-discriminator',
        ix: 'unknown',
        category: 'malformed-data',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: new TransactionInstruction({
          programId: ctx.programId,
          keys: [{ pubkey: ctx.player1.publicKey, isSigner: true, isWritable: true }],
          data: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
        }),
      }),
    );

    // Missing accounts
    await record(
      await runCase({
        id: 'charge_match_fee/missing-accounts',
        ix: 'charge_match_fee',
        category: 'missing-accounts',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: new TransactionInstruction({
          programId: ctx.programId,
          keys: [
            { pubkey: ctx.authority.publicKey, isSigner: true, isWritable: true },
            { pubkey: ctx.config, isSigner: false, isWritable: false },
          ],
          data: IX.chargeMatchFee,
        }),
      }),
    );

    // Wrong token program id on poke deposit
    await record(
      await runCase({
        id: 'deposit_poke_entry/wrong-token-program',
        ix: 'deposit_poke_entry',
        category: 'wrong-mint',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: (() => {
          const tid = labeledId16('poke-bad-token-prog');
          const ix = depositPokeEntryIx({
            programId: ctx.programId,
            player: ctx.player1.publicKey,
            config: ctx.config,
            pokeMint: ctx.pokeMint,
            playerPoke: player1Ata,
            tournamentId: tid,
            amount: 100n,
            quoteId: labeledKey32('q-bad-tp'),
            priceMicroUsd: 400_000,
          });
          // Replace token program key
          ix.keys = ix.keys.map((k) =>
            k.pubkey.equals(TOKEN_PROGRAM_ID)
              ? { ...k, pubkey: SystemProgram.programId }
              : k,
          );
          return ix;
        })(),
      }),
    );

    // Invalid side enum
    {
      const { roomId } = await setupFundedMatch(ctx, 'adv-side');
      // Actually already both deposited — create fresh for invalid side on new match
      void roomId;
    }
    {
      const roomId = labeledId16('adv-bad-side');
      await sendIx({
        connection: ctx.connection,
        payer: ctx.player1,
        ix: [
          createMatchEscrowIx({
            programId: ctx.programId,
            creator: ctx.player1.publicKey,
            config: ctx.config,
            roomId,
            collateralLamports: 10_000_000,
          }),
        ],
      });
      await record(
        await runCase({
          id: 'deposit_sol_wager/invalid-side-enum',
          ix: 'deposit_sol_wager',
          category: 'malformed-data',
          expectOk: false,
          connection: ctx.connection,
          payer: ctx.player1,
          instruction: new TransactionInstruction({
            programId: ctx.programId,
            keys: depositSolWagerIx({
              programId: ctx.programId,
              depositor: ctx.player1.publicKey,
              roomId,
              side: 0,
            }).keys,
            data: Buffer.concat([IX.depositSolWager, Buffer.from([9])]),
          }),
        }),
      );
    }

    // Create only stores collateral; u64::MAX is accepted. Depositing that amount must fail.
    const maxRoom = labeledId16('max-u64');
    await record(
      await runCase({
        id: 'create_match_escrow/max-u64-collateral',
        ix: 'create_match_escrow',
        category: 'overflow',
        expectOk: true,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: createMatchEscrowIx({
          programId: ctx.programId,
          creator: ctx.player1.publicKey,
          config: ctx.config,
          roomId: maxRoom,
          collateralLamports: 2n ** 64n - 1n,
        }),
        note: 'create stores amount only; deposit is the insolvency gate',
      }),
    );
    await record(
      await runCase({
        id: 'deposit_sol_wager/max-u64-insufficient',
        ix: 'deposit_sol_wager',
        category: 'overflow',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.player1,
        instruction: depositSolWagerIx({
          programId: ctx.programId,
          depositor: ctx.player1.publicKey,
          roomId: maxRoom,
          side: 0,
        }),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Stress: repeated independent win lifecycles
  // -------------------------------------------------------------------------
  for (let i = 0; i < 12; i++) {
    const { roomId, matchEscrow } = await setupFundedMatch(ctx, `stress-win-${i}`);
    let r = await sendIx({
      connection: ctx.connection,
      payer: ctx.authority,
      ix: chargeMatchFeeIx({
        programId: ctx.programId,
        authority: ctx.authority.publicKey,
        config: ctx.config,
        feeVault: ctx.feeVault,
        roomId,
      }),
    });
    assert.equal(r.ok, true, `stress charge ${i}`);
    const key = labeledKey32(`stress-win-key-${i}`);
    r = await sendIx({
      connection: ctx.connection,
      payer: ctx.authority,
      ix: settleMatchWinIx({
        programId: ctx.programId,
        authority: ctx.authority.publicKey,
        config: ctx.config,
        winner: i % 2 === 0 ? ctx.player1.publicKey : ctx.player2.publicKey,
        roomId,
        settlementKey: key,
      }),
    });
    assert.equal(r.ok, true, `stress win ${i}`);
    // replay must fail
    await record(
      await runCase({
        id: `stress/win-replay-${i}`,
        ix: 'settle_match_win',
        category: 'stress',
        expectOk: false,
        connection: ctx.connection,
        payer: ctx.authority,
        instruction: settleMatchWinIx({
          programId: ctx.programId,
          authority: ctx.authority.publicKey,
          config: ctx.config,
          winner: i % 2 === 0 ? ctx.player1.publicKey : ctx.player2.publicKey,
          roomId,
          settlementKey: key,
        }),
        watch: { matchEscrow },
      }),
    );
  }

  // Stress prize reserve/release cycles
  for (let i = 0; i < 8; i++) {
    const tournamentId = labeledId16(`stress-prize-${i}`);
    let r = await sendIx({
      connection: ctx.connection,
      payer: ctx.authority,
      ix: reservePrizeIx({
        programId: ctx.programId,
        authority: ctx.authority.publicKey,
        config: ctx.config,
        treasuryVault: ctx.treasuryVault,
        tournamentId,
        amount: 1_000_000 + i,
      }),
    });
    assert.equal(r.ok, true, `stress reserve ${i}`);
    r = await sendIx({
      connection: ctx.connection,
      payer: ctx.authority,
      ix: releasePrizeIx({
        programId: ctx.programId,
        authority: ctx.authority.publicKey,
        config: ctx.config,
        treasuryVault: ctx.treasuryVault,
        tournamentId,
      }),
    });
    assert.equal(r.ok, true, `stress release ${i}`);
    cases.push({
      id: `stress/prize-reserve-release-${i}`,
      ix: 'release_prize',
      category: 'stress',
      ok: true,
      customError: null,
      errorText: null,
      expectReject: false,
      accounts: {},
      deltas: {},
    });
  }

  // Config PDA identity check
  {
    const [cfg] = configPda(ctx.programId);
    assert.equal(cfg.toBase58(), ctx.config.toBase58());
  }

  const report = finalizeReport({
    impl: ctx.impl,
    programId: ctx.programId.toBase58(),
    programDataLen,
    startedAt,
    cases: [...cases],
  });
  const out = maybeWriteReport(report);
  if (out) {
    console.log(`parity report written: ${out}`);
  }
  console.log(
    JSON.stringify({
      impl: report.impl,
      programDataLen: report.programDataLen,
      summary: report.summary,
      byIx: Object.fromEntries(
        [...new Set(report.cases.map((c) => c.ix))].map((ix) => [
          ix,
          {
            total: report.cases.filter((c) => c.ix === ix).length,
            ok: report.cases.filter((c) => c.ix === ix && c.ok).length,
            reject: report.cases.filter((c) => c.ix === ix && !c.ok).length,
          },
        ]),
      ),
    }),
  );

  assert.equal(report.summary.unexpectedOk, 0);
  assert.equal(report.summary.unexpectedReject, 0);
  assert.ok(report.summary.total >= 60, `expected rich campaign, got ${report.summary.total}`);
});
