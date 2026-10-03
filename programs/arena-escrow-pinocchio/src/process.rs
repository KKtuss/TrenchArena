use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::Pubkey,
    seeds,
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};

use crate::{
    error::ArenaError,
    helpers::{
        assert_mint_account, assert_signer, assert_system_account, assert_system_program,
        assert_token_program, assert_writable, authority_or_keeper, create_account_signed,
        init_token_account_pda, load_config, read_bytes_arg, read_u64_arg, read_u8_arg,
        system_transfer, token_amount, token_burn, token_burn_signed, token_mint, token_owner,
        token_transfer, token_transfer_signed, transfer_lamports_direct, verify_pda,
        verify_pda_with_bump, write_account_data,
    },
    state::{
        require, Config, EntryEscrow, EntryStatus, MatchEscrow, MatchStatus, PrizeReserve,
        PrizeStatus, Replay, ReplayKind, TreasuryDeposit, BPS_DENOM, CASUAL_FEE_BPS,
        CONFIG_SPACE, ENTRY_ESCROW_SPACE, MATCH_ESCROW_SPACE, OPERATOR_BPS, PRIZE_RESERVE_SPACE,
        REPLAY_SPACE, TREASURY_BPS, TREASURY_DEPOSIT_SPACE, UNCHECKED_VAULT_SPACE,
    },
};

pub const IX_INITIALIZE_CONFIG: [u8; 8] = [0xd0, 0x7f, 0x15, 0x01, 0xc2, 0xbe, 0xc4, 0x46];
pub const IX_CREATE_MATCH_ESCROW: [u8; 8] = [0xd5, 0x08, 0x31, 0x47, 0x51, 0x14, 0x5a, 0x8e];
pub const IX_DEPOSIT_SOL_WAGER: [u8; 8] = [0xea, 0xeb, 0x9a, 0xfa, 0x43, 0x25, 0x75, 0x88];
pub const IX_SEAT_MATCH_OPPONENT: [u8; 8] = [0x87, 0x0e, 0x6c, 0x18, 0x9a, 0x68, 0x8e, 0x17];
pub const IX_REFUND_SOL_WAGER: [u8; 8] = [0xfe, 0x21, 0x2d, 0x83, 0x9e, 0x5f, 0xa8, 0x8e];
pub const IX_CHARGE_MATCH_FEE: [u8; 8] = [0x97, 0x30, 0x5e, 0x06, 0x48, 0x0f, 0xa5, 0xc4];
pub const IX_SETTLE_MATCH_WIN: [u8; 8] = [0x25, 0xf7, 0x21, 0x06, 0x10, 0x1d, 0xc1, 0xd1];
pub const IX_SETTLE_MATCH_TIE: [u8; 8] = [0x09, 0xc6, 0x23, 0x16, 0x16, 0x4d, 0x7f, 0x0c];
pub const IX_DEPOSIT_POKE_ENTRY: [u8; 8] = [0x0b, 0x33, 0x40, 0x93, 0x42, 0x10, 0x76, 0x2f];
pub const IX_REFUND_POKE_ENTRY: [u8; 8] = [0x83, 0x93, 0x53, 0x4d, 0xd1, 0xf6, 0xc1, 0x04];
pub const IX_BURN_POKE_ENTRY: [u8; 8] = [0xe7, 0x43, 0x93, 0xeb, 0x60, 0x9e, 0xf0, 0x62];
pub const IX_DEPOSIT_TREASURY_SOL: [u8; 8] = [0x5e, 0x08, 0x61, 0xd4, 0xa8, 0x34, 0x43, 0xdd];
pub const IX_RESERVE_PRIZE: [u8; 8] = [0xd5, 0x71, 0x67, 0x54, 0xde, 0x4e, 0x22, 0x96];
pub const IX_SET_PRIZE_WINNER: [u8; 8] = [0xe1, 0x25, 0xdb, 0xb1, 0xb3, 0x2c, 0x3b, 0x27];
pub const IX_PAY_PRIZE: [u8; 8] = [0x50, 0x82, 0x6a, 0x1c, 0xb1, 0x8a, 0xe2, 0x1a];
pub const IX_RELEASE_PRIZE: [u8; 8] = [0x55, 0x53, 0x76, 0x70, 0xca, 0x15, 0x68, 0xd0];
pub const IX_BUYBACK_AND_BURN_POKE: [u8; 8] = [0xa8, 0x02, 0x2f, 0x00, 0x08, 0xc7, 0x26, 0x9d];

pub fn process(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.len() < 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let disc: [u8; 8] = instruction_data[0..8].try_into().unwrap();
    let data = &instruction_data[8..];

    match disc {
        IX_INITIALIZE_CONFIG => process_initialize_config(program_id, accounts, data),
        IX_CREATE_MATCH_ESCROW => process_create_match_escrow(program_id, accounts, data),
        IX_DEPOSIT_SOL_WAGER => process_deposit_sol_wager(program_id, accounts, data),
        IX_SEAT_MATCH_OPPONENT => process_seat_match_opponent(program_id, accounts, data),
        IX_REFUND_SOL_WAGER => process_refund_sol_wager(program_id, accounts, data),
        IX_CHARGE_MATCH_FEE => process_charge_match_fee(program_id, accounts, data),
        IX_SETTLE_MATCH_WIN => process_settle_match_win(program_id, accounts, data),
        IX_SETTLE_MATCH_TIE => process_settle_match_tie(program_id, accounts, data),
        IX_DEPOSIT_POKE_ENTRY => process_deposit_poke_entry(program_id, accounts, data),
        IX_REFUND_POKE_ENTRY => process_refund_poke_entry(program_id, accounts, data),
        IX_BURN_POKE_ENTRY => process_burn_poke_entry(program_id, accounts, data),
        IX_DEPOSIT_TREASURY_SOL => process_deposit_treasury_sol(program_id, accounts, data),
        IX_RESERVE_PRIZE => process_reserve_prize(program_id, accounts, data),
        IX_SET_PRIZE_WINNER => process_set_prize_winner(program_id, accounts, data),
        IX_PAY_PRIZE => process_pay_prize(program_id, accounts, data),
        IX_RELEASE_PRIZE => process_release_prize(program_id, accounts, data),
        IX_BUYBACK_AND_BURN_POKE => process_buyback_and_burn_poke(program_id, accounts, data),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn load_match_escrow(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<MatchEscrow, ProgramError> {
    crate::helpers::assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    MatchEscrow::unpack(&data)
}

fn load_entry_escrow(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<EntryEscrow, ProgramError> {
    crate::helpers::assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    EntryEscrow::unpack(&data)
}

fn load_prize_reserve(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<PrizeReserve, ProgramError> {
    crate::helpers::assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    PrizeReserve::unpack(&data)
}

fn init_replay<'a>(
    authority: &'a AccountInfo,
    replay: &'a AccountInfo,
    system_program: &'a AccountInfo,
    program_id: &Pubkey,
    key: &[u8; 32],
    kind: u8,
) -> ProgramResult {
    assert_system_program(system_program)?;
    let bump = verify_pda(replay, &[b"replay", key.as_ref()], program_id)?;
    let bump_ref = [bump];
    let seeds_arr = seeds!(b"replay", key.as_ref(), &bump_ref);
    let signer = Signer::from(&seeds_arr);
    create_account_signed(authority, replay, REPLAY_SPACE, program_id, &[signer])?;
    let state = Replay {
        key: *key,
        kind,
        bump,
    };
    write_account_data(replay, |d| state.pack(d))
}

// ---------------------------------------------------------------------------
// initialize_config
// accounts: authority, fee_vault, treasury_vault, operator_vault, poke_mint,
//           quote_authority, keeper, config, system_program
// ---------------------------------------------------------------------------
fn process_initialize_config(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, fee_vault, treasury_vault, operator_vault, poke_mint, quote_authority, keeper, config, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (buyback_bps, off) = read_u64_arg(data, 0)?;
    let (min_buyback_lamports, _) = read_u64_arg(data, off)?;
    require(buyback_bps <= BPS_DENOM, ArenaError::InvalidBps)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_system_program(system_program)?;
    assert_mint_account(poke_mint)?;

    // fee_vault
    let fee_bump = verify_pda(fee_vault, &[b"fee_vault"], program_id)?;
    let fee_bump_ref = [fee_bump];
    let fee_seeds = seeds!(b"fee_vault", &fee_bump_ref);
    let fee_signer = Signer::from(&fee_seeds);
    create_account_signed(
        authority,
        fee_vault,
        UNCHECKED_VAULT_SPACE,
        program_id,
        &[fee_signer],
    )?;

    // treasury_vault
    let treas_bump = verify_pda(treasury_vault, &[b"treasury_vault"], program_id)?;
    let treas_bump_ref = [treas_bump];
    let treas_seeds = seeds!(b"treasury_vault", &treas_bump_ref);
    let treas_signer = Signer::from(&treas_seeds);
    create_account_signed(
        authority,
        treasury_vault,
        UNCHECKED_VAULT_SPACE,
        program_id,
        &[treas_signer],
    )?;

    // operator_vault
    let op_bump = verify_pda(operator_vault, &[b"operator_vault"], program_id)?;
    let op_bump_ref = [op_bump];
    let op_seeds = seeds!(b"operator_vault", &op_bump_ref);
    let op_signer = Signer::from(&op_seeds);
    create_account_signed(
        authority,
        operator_vault,
        UNCHECKED_VAULT_SPACE,
        program_id,
        &[op_signer],
    )?;

    // config
    let cfg_bump = verify_pda(config, &[b"config"], program_id)?;
    let cfg_bump_ref = [cfg_bump];
    let cfg_seeds = seeds!(b"config", &cfg_bump_ref);
    let cfg_signer = Signer::from(&cfg_seeds);
    create_account_signed(authority, config, CONFIG_SPACE, program_id, &[cfg_signer])?;

    let cfg = Config {
        authority: *authority.key(),
        fee_vault: *fee_vault.key(),
        treasury_vault: *treasury_vault.key(),
        operator_vault: *operator_vault.key(),
        poke_mint: *poke_mint.key(),
        quote_authority: *quote_authority.key(),
        keeper: *keeper.key(),
        fee_bps: CASUAL_FEE_BPS,
        treasury_bps: TREASURY_BPS,
        operator_bps: OPERATOR_BPS,
        buyback_bps,
        min_buyback_lamports,
        bump: cfg_bump,
    };
    write_account_data(config, |d| cfg.pack(d))
}

// ---------------------------------------------------------------------------
// create_match_escrow
// accounts: creator, config, match_escrow, match_vault, system_program
// ---------------------------------------------------------------------------
fn process_create_match_escrow(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [creator, config, match_escrow, match_vault, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (room_id, off) = read_bytes_arg::<16>(data, 0)?;
    let (collateral_lamports, _) = read_u64_arg(data, off)?;
    require(collateral_lamports > 0, ArenaError::InvalidAmount)?;

    assert_signer(creator)?;
    assert_writable(creator)?;
    assert_system_program(system_program)?;
    let _cfg = load_config(config, program_id)?;

    let escrow_bump = verify_pda(
        match_escrow,
        &[b"match_escrow", room_id.as_ref()],
        program_id,
    )?;
    let escrow_bump_ref = [escrow_bump];
    let escrow_seeds = seeds!(b"match_escrow", room_id.as_ref(), &escrow_bump_ref);
    let escrow_signer = Signer::from(&escrow_seeds);
    create_account_signed(
        creator,
        match_escrow,
        MATCH_ESCROW_SPACE,
        program_id,
        &[escrow_signer],
    )?;

    let state = MatchEscrow {
        room_id,
        creator: *creator.key(),
        opponent: Pubkey::default(),
        collateral_lamports,
        creator_deposited: false,
        opponent_deposited: false,
        fee_charged: false,
        status: MatchStatus::Open as u8,
        bump: escrow_bump,
    };
    write_account_data(match_escrow, |d| state.pack(d))?;

    // Manually create match_vault (space 0, program-owned).
    let vault_bump = verify_pda(match_vault, &[b"match_vault", room_id.as_ref()], program_id)?;
    let vault_bump_ref = [vault_bump];
    let vault_seeds = seeds!(b"match_vault", room_id.as_ref(), &vault_bump_ref);
    let vault_signer = Signer::from(&vault_seeds);
    create_account_signed(creator, match_vault, 0, program_id, &[vault_signer])?;

    Ok(())
}

// ---------------------------------------------------------------------------
// deposit_sol_wager
// accounts: depositor, match_escrow, match_vault, system_program
// ---------------------------------------------------------------------------
fn process_deposit_sol_wager(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [depositor, match_escrow, match_vault, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (side, _) = read_u8_arg(data, 0)?;

    assert_signer(depositor)?;
    assert_writable(depositor)?;
    assert_writable(match_escrow)?;
    assert_writable(match_vault)?;
    assert_system_program(system_program)?;

    let mut escrow = load_match_escrow(match_escrow, program_id)?;
    let bump_ref = [escrow.bump];
    verify_pda_with_bump(
        match_escrow,
        &[b"match_escrow", escrow.room_id.as_ref(), &bump_ref],
        program_id,
    )?;
    verify_pda(
        match_vault,
        &[b"match_vault", escrow.room_id.as_ref()],
        program_id,
    )?;

    require(
        escrow.status == MatchStatus::Open as u8 || escrow.status == MatchStatus::Funding as u8,
        ArenaError::InvalidMatchStatus,
    )?;

    let amount = escrow.collateral_lamports;
    let depositor_key = *depositor.key();

    match side {
        0 => {
            require(depositor_key == escrow.creator, ArenaError::Unauthorized)?;
            require(!escrow.creator_deposited, ArenaError::AlreadyDeposited)?;
            escrow.creator_deposited = true;
        }
        1 => {
            require(escrow.opponent != Pubkey::default(), ArenaError::Unauthorized)?;
            require(depositor_key == escrow.opponent, ArenaError::Unauthorized)?;
            require(!escrow.opponent_deposited, ArenaError::AlreadyDeposited)?;
            escrow.opponent_deposited = true;
        }
        _ => return Err(ArenaError::InvalidSide.into()),
    }

    system_transfer(depositor, match_vault, amount)?;

    escrow.status = if escrow.creator_deposited && escrow.opponent_deposited {
        MatchStatus::Funded as u8
    } else {
        MatchStatus::Funding as u8
    };
    write_account_data(match_escrow, |d| escrow.pack(d))
}

// ---------------------------------------------------------------------------
// seat_match_opponent
// accounts: authority, config, opponent, match_escrow
// ---------------------------------------------------------------------------
fn process_seat_match_opponent(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [authority, config, opponent, match_escrow, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_writable(match_escrow)?;
    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let mut escrow = load_match_escrow(match_escrow, program_id)?;
    let bump_ref = [escrow.bump];
    verify_pda_with_bump(
        match_escrow,
        &[b"match_escrow", escrow.room_id.as_ref(), &bump_ref],
        program_id,
    )?;

    require(
        escrow.status == MatchStatus::Open as u8 || escrow.status == MatchStatus::Funding as u8,
        ArenaError::InvalidMatchStatus,
    )?;
    require(!escrow.opponent_deposited, ArenaError::AlreadyDeposited)?;

    let opponent_key = *opponent.key();
    require(opponent_key != Pubkey::default(), ArenaError::Unauthorized)?;
    require(opponent_key != escrow.creator, ArenaError::Unauthorized)?;
    if escrow.opponent != Pubkey::default() {
        require(escrow.opponent == opponent_key, ArenaError::Unauthorized)?;
        return Ok(());
    }
    escrow.opponent = opponent_key;
    write_account_data(match_escrow, |d| escrow.pack(d))
}

// ---------------------------------------------------------------------------
// refund_sol_wager
// accounts: authority, config, recipient, match_escrow, match_vault
// ---------------------------------------------------------------------------
fn process_refund_sol_wager(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, recipient, match_escrow, match_vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (side, _) = read_u8_arg(data, 0)?;

    assert_signer(authority)?;
    assert_writable(recipient)?;
    assert_writable(match_escrow)?;
    assert_writable(match_vault)?;
    assert_system_account(recipient)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let mut escrow = load_match_escrow(match_escrow, program_id)?;
    let bump_ref = [escrow.bump];
    verify_pda_with_bump(
        match_escrow,
        &[b"match_escrow", escrow.room_id.as_ref(), &bump_ref],
        program_id,
    )?;
    verify_pda(
        match_vault,
        &[b"match_vault", escrow.room_id.as_ref()],
        program_id,
    )?;

    require(
        escrow.status == MatchStatus::Open as u8
            || escrow.status == MatchStatus::Funding as u8
            || escrow.status == MatchStatus::Cancelled as u8,
        ArenaError::InvalidMatchStatus,
    )?;
    require(!escrow.fee_charged, ArenaError::FeeAlreadyCharged)?;

    let amount = escrow.collateral_lamports;
    let expected_recipient = match side {
        0 => {
            require(escrow.creator_deposited, ArenaError::NotDeposited)?;
            escrow.creator
        }
        1 => {
            require(escrow.opponent_deposited, ArenaError::NotDeposited)?;
            escrow.opponent
        }
        _ => return Err(ArenaError::InvalidSide.into()),
    };
    require(
        *recipient.key() == expected_recipient,
        ArenaError::Unauthorized,
    )?;

    transfer_lamports_direct(match_vault, recipient, amount)?;

    match side {
        0 => escrow.creator_deposited = false,
        1 => escrow.opponent_deposited = false,
        _ => {}
    }
    escrow.status = MatchStatus::Cancelled as u8;
    write_account_data(match_escrow, |d| escrow.pack(d))
}

// ---------------------------------------------------------------------------
// charge_match_fee
// accounts: authority, config, match_escrow, match_vault, fee_vault
// ---------------------------------------------------------------------------
fn process_charge_match_fee(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [authority, config, match_escrow, match_vault, fee_vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_writable(match_escrow)?;
    assert_writable(match_vault)?;
    assert_writable(fee_vault)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    require(*fee_vault.key() == cfg.fee_vault, ArenaError::Unauthorized)?;

    let mut escrow = load_match_escrow(match_escrow, program_id)?;
    let bump_ref = [escrow.bump];
    verify_pda_with_bump(
        match_escrow,
        &[b"match_escrow", escrow.room_id.as_ref(), &bump_ref],
        program_id,
    )?;
    verify_pda(
        match_vault,
        &[b"match_vault", escrow.room_id.as_ref()],
        program_id,
    )?;

    require(
        escrow.status == MatchStatus::Funded as u8,
        ArenaError::InvalidMatchStatus,
    )?;
    require(!escrow.fee_charged, ArenaError::FeeAlreadyCharged)?;

    let total = escrow
        .collateral_lamports
        .checked_mul(2)
        .ok_or(ArenaError::Overflow)?;
    let fee = total
        .checked_mul(cfg.fee_bps)
        .ok_or(ArenaError::Overflow)?
        / BPS_DENOM;

    transfer_lamports_direct(match_vault, fee_vault, fee)?;

    escrow.fee_charged = true;
    escrow.status = MatchStatus::Active as u8;
    write_account_data(match_escrow, |d| escrow.pack(d))
}

// ---------------------------------------------------------------------------
// settle_match_win
// accounts: authority, config, winner, match_escrow, match_vault, replay, system_program
// ---------------------------------------------------------------------------
fn process_settle_match_win(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, winner, match_escrow, match_vault, replay, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (settlement_key, _) = read_bytes_arg::<32>(data, 0)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(winner)?;
    assert_writable(match_escrow)?;
    assert_writable(match_vault)?;
    assert_system_account(winner)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let mut escrow = load_match_escrow(match_escrow, program_id)?;
    let bump_ref = [escrow.bump];
    verify_pda_with_bump(
        match_escrow,
        &[b"match_escrow", escrow.room_id.as_ref(), &bump_ref],
        program_id,
    )?;
    verify_pda(
        match_vault,
        &[b"match_vault", escrow.room_id.as_ref()],
        program_id,
    )?;

    require(
        escrow.status == MatchStatus::Active as u8,
        ArenaError::InvalidMatchStatus,
    )?;
    require(escrow.fee_charged, ArenaError::FeeNotCharged)?;

    let winner_key = *winner.key();
    require(
        winner_key == escrow.creator || winner_key == escrow.opponent,
        ArenaError::Unauthorized,
    )?;

    init_replay(
        authority,
        replay,
        system_program,
        program_id,
        &settlement_key,
        ReplayKind::MatchWin as u8,
    )?;

    let vault_lamports = match_vault.lamports();
    let rent = Rent::get()?.minimum_balance(0);
    let payout = vault_lamports.saturating_sub(rent);
    transfer_lamports_direct(match_vault, winner, payout)?;

    escrow.status = MatchStatus::Settled as u8;
    write_account_data(match_escrow, |d| escrow.pack(d))
}

// ---------------------------------------------------------------------------
// settle_match_tie
// accounts: authority, config, match_escrow, creator, opponent, match_vault, replay, system_program
// ---------------------------------------------------------------------------
fn process_settle_match_tie(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, match_escrow, creator, opponent, match_vault, replay, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (settlement_key, _) = read_bytes_arg::<32>(data, 0)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(match_escrow)?;
    assert_writable(creator)?;
    assert_writable(opponent)?;
    assert_writable(match_vault)?;
    assert_system_account(creator)?;
    assert_system_account(opponent)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let mut escrow = load_match_escrow(match_escrow, program_id)?;
    let bump_ref = [escrow.bump];
    verify_pda_with_bump(
        match_escrow,
        &[b"match_escrow", escrow.room_id.as_ref(), &bump_ref],
        program_id,
    )?;
    verify_pda(
        match_vault,
        &[b"match_vault", escrow.room_id.as_ref()],
        program_id,
    )?;
    require(*creator.key() == escrow.creator, ArenaError::Unauthorized)?;
    require(*opponent.key() == escrow.opponent, ArenaError::Unauthorized)?;

    require(
        escrow.status == MatchStatus::Funded as u8 || escrow.status == MatchStatus::Active as u8,
        ArenaError::InvalidMatchStatus,
    )?;

    init_replay(
        authority,
        replay,
        system_program,
        program_id,
        &settlement_key,
        ReplayKind::MatchTie as u8,
    )?;

    let vault_lamports = match_vault.lamports();
    let rent = Rent::get()?.minimum_balance(0);
    let payout = vault_lamports.saturating_sub(rent);
    let each = payout / 2;
    let rem = payout - each * 2;

    // Remainder goes to opponent (Anchor behavior).
    transfer_lamports_direct(match_vault, creator, each)?;
    transfer_lamports_direct(match_vault, opponent, each + rem)?;

    escrow.status = MatchStatus::Settled as u8;
    write_account_data(match_escrow, |d| escrow.pack(d))
}

// ---------------------------------------------------------------------------
// deposit_poke_entry
// accounts: player, config, poke_mint, player_poke, entry_escrow, entry_vault,
//           token_program, system_program, rent
// ---------------------------------------------------------------------------
fn process_deposit_poke_entry(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [player, config, poke_mint, player_poke, entry_escrow, entry_vault, token_program, system_program, rent_sysvar, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    let (tournament_id, off) = read_bytes_arg::<16>(data, 0)?;
    let (amount, off) = read_u64_arg(data, off)?;
    let (quote_id, off) = read_bytes_arg::<32>(data, off)?;
    let (price_micro_usd, _) = read_u64_arg(data, off)?;
    require(amount > 0, ArenaError::InvalidAmount)?;

    assert_signer(player)?;
    assert_writable(player)?;
    assert_writable(player_poke)?;
    assert_system_program(system_program)?;
    assert_token_program(token_program)?;
    if rent_sysvar.key() != &pinocchio::sysvars::rent::RENT_ID {
        return Err(ProgramError::InvalidArgument);
    }

    let cfg = load_config(config, program_id)?;
    assert_mint_account(poke_mint)?;
    require(*poke_mint.key() == cfg.poke_mint, ArenaError::Unauthorized)?;

    let player_mint = token_mint(player_poke)?;
    require(player_mint == *poke_mint.key(), ArenaError::Unauthorized)?;
    let player_auth = token_owner(player_poke)?;
    require(player_auth == *player.key(), ArenaError::Unauthorized)?;

    let entry_bump = verify_pda(
        entry_escrow,
        &[b"entry_escrow", tournament_id.as_ref(), player.key().as_ref()],
        program_id,
    )?;
    let entry_bump_ref = [entry_bump];
    let entry_seeds = seeds!(
        b"entry_escrow",
        tournament_id.as_ref(),
        player.key().as_ref(),
        &entry_bump_ref
    );
    let entry_signer = Signer::from(&entry_seeds);
    create_account_signed(
        player,
        entry_escrow,
        ENTRY_ESCROW_SPACE,
        program_id,
        &[entry_signer],
    )?;

    let vault_bump = verify_pda(
        entry_vault,
        &[b"entry_vault", tournament_id.as_ref(), player.key().as_ref()],
        program_id,
    )?;
    let vault_bump_ref = [vault_bump];
    let vault_seeds = seeds!(
        b"entry_vault",
        tournament_id.as_ref(),
        player.key().as_ref(),
        &vault_bump_ref
    );
    let vault_signer = Signer::from(&vault_seeds);
    init_token_account_pda(
        player,
        entry_vault,
        poke_mint,
        entry_escrow.key(),
        &[vault_signer],
    )?;

    let entry = EntryEscrow {
        tournament_id,
        player: *player.key(),
        amount,
        quote_id,
        price_micro_usd,
        status: EntryStatus::Reserved as u8,
        bump: entry_bump,
    };
    write_account_data(entry_escrow, |d| entry.pack(d))?;

    token_transfer(player_poke, entry_vault, player, amount)
}

// ---------------------------------------------------------------------------
// refund_poke_entry
// accounts: authority, config, poke_mint, entry_escrow, player_poke, entry_vault, token_program
// ---------------------------------------------------------------------------
fn process_refund_poke_entry(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [authority, config, poke_mint, entry_escrow, player_poke, entry_vault, token_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_writable(entry_escrow)?;
    assert_writable(player_poke)?;
    assert_writable(entry_vault)?;
    assert_token_program(token_program)?;

    let cfg = load_config(config, program_id)?;
    assert_mint_account(poke_mint)?;
    require(*poke_mint.key() == cfg.poke_mint, ArenaError::Unauthorized)?;

    let mut entry = load_entry_escrow(entry_escrow, program_id)?;
    let bump_ref = [entry.bump];
    verify_pda_with_bump(
        entry_escrow,
        &[
            b"entry_escrow",
            entry.tournament_id.as_ref(),
            entry.player.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        entry_vault,
        &[
            b"entry_vault",
            entry.tournament_id.as_ref(),
            entry.player.as_ref(),
        ],
        program_id,
    )?;

    require(
        entry.status == EntryStatus::Reserved as u8,
        ArenaError::InvalidEntryStatus,
    )?;
    let auth = *authority.key();
    require(
        auth == cfg.authority || auth == cfg.keeper || auth == entry.player,
        ArenaError::Unauthorized,
    )?;

    let player_mint = token_mint(player_poke)?;
    require(player_mint == *poke_mint.key(), ArenaError::Unauthorized)?;
    let player_owner = token_owner(player_poke)?;
    require(player_owner == entry.player, ArenaError::Unauthorized)?;

    let vault_mint = token_mint(entry_vault)?;
    require(vault_mint == *poke_mint.key(), ArenaError::Unauthorized)?;

    let amount = entry.amount;
    let seeds_arr = seeds!(
        b"entry_escrow",
        entry.tournament_id.as_ref(),
        entry.player.as_ref(),
        &bump_ref
    );
    let signer = Signer::from(&seeds_arr);
    token_transfer_signed(entry_vault, player_poke, entry_escrow, amount, &[signer])?;

    entry.status = EntryStatus::Refunded as u8;
    write_account_data(entry_escrow, |d| entry.pack(d))
}

// ---------------------------------------------------------------------------
// burn_poke_entry
// accounts: authority, config, poke_mint, entry_escrow, entry_vault, replay,
//           token_program, system_program
// ---------------------------------------------------------------------------
fn process_burn_poke_entry(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, poke_mint, entry_escrow, entry_vault, replay, token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (burn_key, _) = read_bytes_arg::<32>(data, 0)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(poke_mint)?;
    assert_writable(entry_escrow)?;
    assert_writable(entry_vault)?;
    assert_token_program(token_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    assert_mint_account(poke_mint)?;
    require(*poke_mint.key() == cfg.poke_mint, ArenaError::Unauthorized)?;

    let mut entry = load_entry_escrow(entry_escrow, program_id)?;
    let bump_ref = [entry.bump];
    verify_pda_with_bump(
        entry_escrow,
        &[
            b"entry_escrow",
            entry.tournament_id.as_ref(),
            entry.player.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        entry_vault,
        &[
            b"entry_vault",
            entry.tournament_id.as_ref(),
            entry.player.as_ref(),
        ],
        program_id,
    )?;

    require(
        entry.status == EntryStatus::Reserved as u8,
        ArenaError::InvalidEntryStatus,
    )?;

    let vault_mint = token_mint(entry_vault)?;
    require(vault_mint == *poke_mint.key(), ArenaError::Unauthorized)?;
    let vault_owner = token_owner(entry_vault)?;
    require(vault_owner == *entry_escrow.key(), ArenaError::Unauthorized)?;

    init_replay(
        authority,
        replay,
        system_program,
        program_id,
        &burn_key,
        ReplayKind::EntryBurn as u8,
    )?;

    let amount = entry.amount;
    let seeds_arr = seeds!(
        b"entry_escrow",
        entry.tournament_id.as_ref(),
        entry.player.as_ref(),
        &bump_ref
    );
    let signer = Signer::from(&seeds_arr);
    token_burn_signed(entry_vault, poke_mint, entry_escrow, amount, &[signer])?;

    entry.status = EntryStatus::Burned as u8;
    write_account_data(entry_escrow, |d| entry.pack(d))
}

// ---------------------------------------------------------------------------
// deposit_treasury_sol
// accounts: authority, payer, config, treasury_vault, operator_vault,
//           treasury_deposit, replay, system_program
// ---------------------------------------------------------------------------
fn process_deposit_treasury_sol(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, payer, config, treasury_vault, operator_vault, treasury_deposit, replay, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (claim_key, off) = read_bytes_arg::<32>(data, 0)?;
    let (gross_lamports, _) = read_u64_arg(data, off)?;
    require(gross_lamports > 0, ArenaError::InvalidAmount)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_signer(payer)?;
    assert_writable(payer)?;
    assert_writable(treasury_vault)?;
    assert_writable(operator_vault)?;
    assert_system_program(system_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    require(
        *treasury_vault.key() == cfg.treasury_vault,
        ArenaError::Unauthorized,
    )?;
    require(
        *operator_vault.key() == cfg.operator_vault,
        ArenaError::Unauthorized,
    )?;

    let treasury_share = gross_lamports
        .checked_mul(cfg.treasury_bps)
        .ok_or(ArenaError::Overflow)?
        / BPS_DENOM;
    let operator_share = gross_lamports
        .checked_sub(treasury_share)
        .ok_or(ArenaError::Overflow)?;

    // Anchor `init` runs before handler body — create PDAs before SOL transfers
    // so authority==payer still has rent lamports available.
    let ledger_bump = verify_pda(
        treasury_deposit,
        &[b"treasury_deposit", claim_key.as_ref()],
        program_id,
    )?;
    let ledger_bump_ref = [ledger_bump];
    let ledger_seeds = seeds!(b"treasury_deposit", claim_key.as_ref(), &ledger_bump_ref);
    let ledger_signer = Signer::from(&ledger_seeds);
    create_account_signed(
        authority,
        treasury_deposit,
        TREASURY_DEPOSIT_SPACE,
        program_id,
        &[ledger_signer],
    )?;

    init_replay(
        authority,
        replay,
        system_program,
        program_id,
        &claim_key,
        ReplayKind::TreasuryDeposit as u8,
    )?;

    system_transfer(payer, treasury_vault, treasury_share)?;
    system_transfer(payer, operator_vault, operator_share)?;

    let ledger = TreasuryDeposit {
        claim_key,
        gross_lamports,
        treasury_lamports: treasury_share,
        operator_lamports: operator_share,
        bump: ledger_bump,
    };
    write_account_data(treasury_deposit, |d| ledger.pack(d))
}

// ---------------------------------------------------------------------------
// reserve_prize
// accounts: authority, config, treasury_vault, prize_vault, prize_reserve, system_program
// ---------------------------------------------------------------------------
fn process_reserve_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, treasury_vault, prize_vault, prize_reserve, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (tournament_id, off) = read_bytes_arg::<16>(data, 0)?;
    let (amount, _) = read_u64_arg(data, off)?;
    require(amount > 0, ArenaError::InvalidAmount)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(treasury_vault)?;
    assert_writable(prize_vault)?;
    assert_system_program(system_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    require(
        *treasury_vault.key() == cfg.treasury_vault,
        ArenaError::Unauthorized,
    )?;

    let reserve_bump = verify_pda(
        prize_reserve,
        &[b"prize_reserve", tournament_id.as_ref()],
        program_id,
    )?;
    let reserve_bump_ref = [reserve_bump];
    let reserve_seeds = seeds!(b"prize_reserve", tournament_id.as_ref(), &reserve_bump_ref);
    let reserve_signer = Signer::from(&reserve_seeds);
    create_account_signed(
        authority,
        prize_reserve,
        PRIZE_RESERVE_SPACE,
        program_id,
        &[reserve_signer],
    )?;

    let reserve = PrizeReserve {
        tournament_id,
        winner: Pubkey::default(),
        amount,
        status: PrizeStatus::Reserved as u8,
        winner_set: false,
        bump: reserve_bump,
    };
    write_account_data(prize_reserve, |d| reserve.pack(d))?;

    let vault_bump = verify_pda(
        prize_vault,
        &[b"prize_vault", tournament_id.as_ref()],
        program_id,
    )?;
    // Ensure prize vault PDA exists (empty → create), matching Anchor.
    if prize_vault.lamports() == 0 && prize_vault.data_is_empty() {
        let vault_bump_ref = [vault_bump];
        let vault_seeds = seeds!(b"prize_vault", tournament_id.as_ref(), &vault_bump_ref);
        let vault_signer = Signer::from(&vault_seeds);
        create_account_signed(authority, prize_vault, 0, program_id, &[vault_signer])?;
    }

    transfer_lamports_direct(treasury_vault, prize_vault, amount)
}

// ---------------------------------------------------------------------------
// set_prize_winner
// accounts: authority, config, prize_reserve, winner
// ---------------------------------------------------------------------------
fn process_set_prize_winner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [authority, config, prize_reserve, winner, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_writable(prize_reserve)?;
    assert_system_account(winner)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let mut reserve = load_prize_reserve(prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        prize_reserve,
        &[
            b"prize_reserve",
            reserve.tournament_id.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;

    require(
        reserve.status == PrizeStatus::Reserved as u8,
        ArenaError::InvalidPrizeStatus,
    )?;
    require(!reserve.winner_set, ArenaError::PrizeWinnerAlreadySet)?;

    reserve.winner = *winner.key();
    reserve.winner_set = true;
    write_account_data(prize_reserve, |d| reserve.pack(d))
}

// ---------------------------------------------------------------------------
// pay_prize
// accounts: authority, config, prize_reserve, winner, prize_vault, replay, system_program
// ---------------------------------------------------------------------------
fn process_pay_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, prize_reserve, winner, prize_vault, replay, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (settlement_key, _) = read_bytes_arg::<32>(data, 0)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(prize_reserve)?;
    assert_writable(winner)?;
    assert_writable(prize_vault)?;
    assert_system_account(winner)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let mut reserve = load_prize_reserve(prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        prize_reserve,
        &[
            b"prize_reserve",
            reserve.tournament_id.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        prize_vault,
        &[b"prize_vault", reserve.tournament_id.as_ref()],
        program_id,
    )?;
    require(*winner.key() == reserve.winner, ArenaError::Unauthorized)?;

    require(
        reserve.status == PrizeStatus::Reserved as u8,
        ArenaError::InvalidPrizeStatus,
    )?;
    require(reserve.winner_set, ArenaError::PrizeWinnerNotSet)?;

    init_replay(
        authority,
        replay,
        system_program,
        program_id,
        &settlement_key,
        ReplayKind::PrizePay as u8,
    )?;

    let amount = reserve.amount;
    transfer_lamports_direct(prize_vault, winner, amount)?;
    reserve.status = PrizeStatus::Paid as u8;
    write_account_data(prize_reserve, |d| reserve.pack(d))
}

// ---------------------------------------------------------------------------
// release_prize
// accounts: authority, config, treasury_vault, prize_reserve, prize_vault
// ---------------------------------------------------------------------------
fn process_release_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    let [authority, config, treasury_vault, prize_reserve, prize_vault, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_writable(treasury_vault)?;
    assert_writable(prize_reserve)?;
    assert_writable(prize_vault)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    require(
        *treasury_vault.key() == cfg.treasury_vault,
        ArenaError::Unauthorized,
    )?;

    let mut reserve = load_prize_reserve(prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        prize_reserve,
        &[
            b"prize_reserve",
            reserve.tournament_id.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        prize_vault,
        &[b"prize_vault", reserve.tournament_id.as_ref()],
        program_id,
    )?;

    require(
        reserve.status == PrizeStatus::Reserved as u8,
        ArenaError::InvalidPrizeStatus,
    )?;

    let amount = reserve.amount;
    transfer_lamports_direct(prize_vault, treasury_vault, amount)?;
    reserve.status = PrizeStatus::Released as u8;
    write_account_data(prize_reserve, |d| reserve.pack(d))
}

// ---------------------------------------------------------------------------
// buyback_and_burn_poke
// accounts: authority, config, fee_vault, swap_wallet, poke_mint, poke_burn_source,
//           replay, token_program, system_program
// ---------------------------------------------------------------------------
fn process_buyback_and_burn_poke(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, fee_vault, swap_wallet, poke_mint, poke_burn_source, replay, token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (buyback_key, off) = read_bytes_arg::<32>(data, 0)?;
    let (sol_amount, off) = read_u64_arg(data, off)?;
    let (min_poke_out, _) = read_u64_arg(data, off)?;
    require(sol_amount > 0, ArenaError::InvalidAmount)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(fee_vault)?;
    assert_writable(swap_wallet)?;
    assert_writable(poke_mint)?;
    assert_writable(poke_burn_source)?;
    assert_token_program(token_program)?;
    let _ = system_program; // present for Anchor parity / replay init

    let cfg = load_config(config, program_id)?;
    require(
        sol_amount >= cfg.min_buyback_lamports,
        ArenaError::BuybackTooSmall,
    )?;
    authority_or_keeper(authority, &cfg)?;
    require(*fee_vault.key() == cfg.fee_vault, ArenaError::Unauthorized)?;
    assert_mint_account(poke_mint)?;
    require(*poke_mint.key() == cfg.poke_mint, ArenaError::Unauthorized)?;

    let burn_mint = token_mint(poke_burn_source)?;
    require(burn_mint == *poke_mint.key(), ArenaError::Unauthorized)?;
    let burn_owner = token_owner(poke_burn_source)?;
    require(burn_owner == *authority.key(), ArenaError::Unauthorized)?;

    let max_sol = fee_vault
        .lamports()
        .saturating_sub(Rent::get()?.minimum_balance(0));
    let spend = sol_amount
        .checked_mul(cfg.buyback_bps)
        .ok_or(ArenaError::Overflow)?
        / BPS_DENOM;
    require(spend > 0 && spend <= max_sol, ArenaError::InsufficientFunds)?;

    init_replay(
        authority,
        replay,
        system_program,
        program_id,
        &buyback_key,
        ReplayKind::BuybackBurn as u8,
    )?;

    transfer_lamports_direct(fee_vault, swap_wallet, spend)?;

    let available = token_amount(poke_burn_source)?;
    require(available >= min_poke_out, ArenaError::SlippageExceeded)?;
    token_burn(poke_burn_source, poke_mint, authority, min_poke_out)
}
