//! CARDS prize rail, ported from the staging Pinocchio program:
//! `PokeArena-staging/programs/arena-escrow-pinocchio/src/process.rs`.
//!
//! CARDS accounts and CPIs use classic SPL Token. POKE stays on Token-2022
//! in `process.rs` / `helpers.rs`. `pay_cards_prize` transfers the stored
//! CARDS amount. Tournament payout allocation is champion-only in the
//! application layer; this program transfers the stored reserve amount.

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
        assert_owned_by, assert_signer, assert_spl_mint_account, assert_spl_token_program,
        assert_system_account, assert_system_program, assert_token_program, assert_writable,
        authority_or_keeper, close_token_account_signed, create_account_signed,
        init_spl_token_account_pda, load_config, read_bytes_arg, read_u64_arg,
        spl_close_account_signed, spl_token_amount, spl_token_mint, spl_token_owner,
        spl_token_transfer, spl_token_transfer_signed, token_amount, token_mint, token_owner,
        transfer_lamports_direct, verify_pda, verify_pda_with_bump, write_account_data,
        SYSTEM_PROGRAM_ID,
    },
    process::init_replay_account,
    state::{
        require, CardsPrizeReserve, EntryEscrow, EntryStatus, MatchEscrow, MatchStatus, PrizeStatus,
        Replay, ReplayKind, BPS_DENOM, CARDS_MINT_DECIMALS, CARDS_PRIZE_RESERVE_SPACE,
    },
};

pub const IX_SET_CARDS_MINT: [u8; 8] = [0x82, 0xd2, 0xc6, 0x7b, 0x36, 0xa9, 0xc2, 0x05];
pub const IX_FUND_CARDS_PRIZE: [u8; 8] = [0x3e, 0x1e, 0x5d, 0x90, 0xe5, 0x10, 0x2e, 0x85];
pub const IX_SET_CARDS_PRIZE_WINNER: [u8; 8] = [0xa1, 0x81, 0xb1, 0x47, 0x8e, 0x72, 0x56, 0x03];
pub const IX_PAY_CARDS_PRIZE: [u8; 8] = [0xae, 0xf4, 0x9a, 0x5e, 0x95, 0xe8, 0x12, 0x39];
pub const IX_RELEASE_CARDS_PRIZE: [u8; 8] = [0x7d, 0xa6, 0xb0, 0xa7, 0x96, 0x2f, 0x15, 0xa4];
pub const IX_CLAIM_FEE_VAULT: [u8; 8] = [0x34, 0x7e, 0x23, 0x73, 0xfc, 0xd0, 0x9a, 0xed];
pub const IX_INIT_CARDS_REWARD_VAULTS: [u8; 8] = [0x7c, 0xc8, 0x85, 0x3f, 0x3a, 0xf1, 0x09, 0x7a];
pub const IX_CLAIM_CARDS_OPERATOR: [u8; 8] = [0x52, 0xb5, 0x91, 0xc4, 0x99, 0xbb, 0xf1, 0x44];
pub const IX_FUND_CARDS_PRIZE_FROM_TREASURY: [u8; 8] =
    [0xbc, 0x14, 0xd0, 0xee, 0xa0, 0x73, 0x1d, 0x88];
pub const IX_CLOSE_SETTLED_MATCH: [u8; 8] = [0xa5, 0xf3, 0x4b, 0xa4, 0xa4, 0xc6, 0xec, 0x46];
pub const IX_CLOSE_FINAL_CARDS_PRIZE: [u8; 8] = [0x7c, 0x41, 0x7b, 0xe8, 0x1e, 0xb6, 0x1f, 0xee];
pub const IX_CLAIM_OPERATOR_FEES: [u8; 8] = [0x2b, 0x15, 0xd5, 0xa3, 0x7a, 0x56, 0x9d, 0x08];
pub const IX_CLOSE_FINAL_ENTRY: [u8; 8] = [0x8a, 0x2d, 0xbb, 0x0a, 0x88, 0x46, 0x83, 0x4e];

fn validated_cards_mint(mint: &AccountInfo) -> Result<Pubkey, ProgramError> {
    if mint.key() == &SYSTEM_PROGRAM_ID || *mint.key() == Pubkey::default() {
        return Err(ArenaError::InvalidMint.into());
    }
    if assert_spl_mint_account(mint).is_err() {
        return Err(ArenaError::InvalidMint.into());
    }
    let data = mint.try_borrow_data()?;
    if data.len() != 82 || data[44] != CARDS_MINT_DECIMALS {
        return Err(ArenaError::InvalidMint.into());
    }
    Ok(*mint.key())
}

fn assert_cards_mint_account(mint: &AccountInfo) -> Result<(), ProgramError> {
    validated_cards_mint(mint).map(|_| ())
}

fn load_cards_prize_reserve(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<CardsPrizeReserve, ProgramError> {
    assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    CardsPrizeReserve::unpack(&data)
}

fn load_match_escrow(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<MatchEscrow, ProgramError> {
    assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    MatchEscrow::unpack(&data)
}

fn load_entry_escrow(
    account: &AccountInfo,
    program_id: &Pubkey,
) -> Result<EntryEscrow, ProgramError> {
    assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    EntryEscrow::unpack(&data)
}

fn require_poke_configured(config: &crate::state::Config) -> Result<(), ProgramError> {
    if config.poke_mint == Pubkey::default() {
        return Err(ArenaError::PokeMintNotConfigured.into());
    }
    Ok(())
}

fn key_is_set(key: &[u8; 32]) -> bool {
    key.iter().any(|byte| *byte != 0)
}

fn assert_rent_only(account: &AccountInfo) -> ProgramResult {
    let len = {
        let data = account.try_borrow_data()?;
        data.len()
    };
    let rent = Rent::get()?.minimum_balance(len);
    require(account.lamports() == rent, ArenaError::BalanceRemaining)
}

fn close_rent_account(account: &AccountInfo, recipient: &AccountInfo) -> ProgramResult {
    require(*account.key() != *recipient.key(), ArenaError::Unauthorized)?;
    assert_rent_only(account)?;
    let rent = Rent::get()?.minimum_balance({
        let data = account.try_borrow_data()?;
        data.len()
    });
    transfer_lamports_direct(account, recipient, rent)?;
    write_account_data(account, |data| {
        data.fill(0);
        Ok(())
    })
}

fn require_replay(
    replay: &AccountInfo,
    program_id: &Pubkey,
    key: &[u8; 32],
    allowed_kinds: &[u8],
) -> ProgramResult {
    require(key_is_set(key), ArenaError::Unauthorized)?;
    assert_owned_by(replay, program_id)?;
    let state = {
        let data = replay.try_borrow_data()?;
        Replay::unpack(&data)?
    };
    require(state.key == *key, ArenaError::Unauthorized)?;
    require(
        allowed_kinds.contains(&state.kind),
        ArenaError::Unauthorized,
    )?;
    verify_pda(replay, &[b"replay", key.as_ref()], program_id)?;
    assert_writable(replay)?;
    assert_rent_only(replay)
}

pub fn process_set_cards_mint(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let [authority, config, cards_mint, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    assert_signer(authority)?;
    assert_writable(config)?;
    let mut cfg = load_config(config, program_id)?;
    require(*authority.key() == cfg.authority, ArenaError::Unauthorized)?;
    require(
        cfg.cards_mint == Pubkey::default(),
        ArenaError::CardsMintAlreadySet,
    )?;
    cfg.cards_mint = validated_cards_mint(cards_mint)?;
    write_account_data(config, |d| cfg.pack(d))
}

pub fn process_fund_cards_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        funding_authority,
        config,
        cards_mint,
        funding_cards,
        cards_prize_reserve,
        cards_prize_vault,
        replay,
        token_program,
        system_program,
        ..
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (tournament_id, off) = read_bytes_arg::<16>(data, 0)?;
    let (amount, off) = read_u64_arg(data, off)?;
    let (funding_key, _) = read_bytes_arg::<32>(data, off)?;
    require(amount > 0, ArenaError::InvalidAmount)?;

    assert_signer(funding_authority)?;
    assert_writable(funding_authority)?;
    assert_writable(funding_cards)?;
    assert_writable(cards_prize_reserve)?;
    assert_writable(cards_prize_vault)?;
    assert_spl_token_program(token_program)?;
    assert_system_program(system_program)?;

    let cfg = load_config(config, program_id)?;
    require(
        cfg.cards_mint != Pubkey::default(),
        ArenaError::CardsMintNotConfigured,
    )?;
    authority_or_keeper(funding_authority, &cfg)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;
    require(
        spl_token_mint(funding_cards)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(funding_cards)? == *funding_authority.key(),
        ArenaError::Unauthorized,
    )?;

    let reserve_bump = verify_pda(
        cards_prize_reserve,
        &[b"cards_prize_reserve", tournament_id.as_ref()],
        program_id,
    )?;
    let reserve_bump_ref = [reserve_bump];
    let reserve_seeds = seeds!(
        b"cards_prize_reserve",
        tournament_id.as_ref(),
        &reserve_bump_ref
    );
    let reserve_signer = Signer::from(&reserve_seeds);
    create_account_signed(
        funding_authority,
        cards_prize_reserve,
        CARDS_PRIZE_RESERVE_SPACE,
        program_id,
        &[reserve_signer],
    )?;

    let vault_bump = verify_pda(
        cards_prize_vault,
        &[b"cards_prize_vault", tournament_id.as_ref()],
        program_id,
    )?;
    let vault_bump_ref = [vault_bump];
    let vault_seeds = seeds!(
        b"cards_prize_vault",
        tournament_id.as_ref(),
        &vault_bump_ref
    );
    let vault_signer = Signer::from(&vault_seeds);
    init_spl_token_account_pda(
        funding_authority,
        cards_prize_vault,
        cards_mint,
        cards_prize_reserve.key(),
        &[vault_signer],
    )?;

    init_replay_account(
        funding_authority,
        replay,
        system_program,
        program_id,
        &funding_key,
        ReplayKind::CardsPrizeFund as u8,
    )?;

    let reserve = CardsPrizeReserve {
        tournament_id,
        funder: *funding_authority.key(),
        winner: Pubkey::default(),
        cards_amount: amount,
        status: PrizeStatus::Reserved as u8,
        winner_set: false,
        bump: reserve_bump,
        fund_key: funding_key,
        pay_key: [0u8; 32],
    };
    write_account_data(cards_prize_reserve, |d| reserve.pack(d))?;
    spl_token_transfer(funding_cards, cards_prize_vault, funding_authority, amount)
}

pub fn process_set_cards_prize_winner(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [authority, config, cards_prize_reserve, winner, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    assert_signer(authority)?;
    assert_writable(cards_prize_reserve)?;
    assert_system_account(winner)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    let mut reserve = load_cards_prize_reserve(cards_prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        cards_prize_reserve,
        &[
            b"cards_prize_reserve",
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
    write_account_data(cards_prize_reserve, |d| reserve.pack(d))
}

pub fn process_pay_cards_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        authority,
        config,
        cards_mint,
        cards_prize_reserve,
        winner,
        winner_cards,
        cards_prize_vault,
        replay,
        token_program,
        system_program,
        ..
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (settlement_key, _) = read_bytes_arg::<32>(data, 0)?;

    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(cards_prize_reserve)?;
    assert_writable(winner_cards)?;
    assert_writable(cards_prize_vault)?;
    assert_spl_token_program(token_program)?;
    assert_system_program(system_program)?;
    assert_system_account(winner)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;
    let mut reserve = load_cards_prize_reserve(cards_prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        cards_prize_reserve,
        &[
            b"cards_prize_reserve",
            reserve.tournament_id.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        cards_prize_vault,
        &[b"cards_prize_vault", reserve.tournament_id.as_ref()],
        program_id,
    )?;
    require(*winner.key() == reserve.winner, ArenaError::Unauthorized)?;
    require(
        spl_token_mint(winner_cards)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(winner_cards)? == *winner.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_mint(cards_prize_vault)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(cards_prize_vault)? == *cards_prize_reserve.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        reserve.status == PrizeStatus::Reserved as u8,
        ArenaError::InvalidPrizeStatus,
    )?;
    require(reserve.winner_set, ArenaError::PrizeWinnerNotSet)?;

    init_replay_account(
        authority,
        replay,
        system_program,
        program_id,
        &settlement_key,
        ReplayKind::CardsPrizePay as u8,
    )?;
    let seeds_arr = seeds!(
        b"cards_prize_reserve",
        reserve.tournament_id.as_ref(),
        &bump_ref
    );
    let signer = Signer::from(&seeds_arr);
    spl_token_transfer_signed(
        cards_prize_vault,
        winner_cards,
        cards_prize_reserve,
        reserve.cards_amount,
        &[signer],
    )?;
    reserve.pay_key = settlement_key;
    reserve.status = PrizeStatus::Paid as u8;
    write_account_data(cards_prize_reserve, |d| reserve.pack(d))
}

pub fn process_release_cards_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [
        authority,
        config,
        cards_mint,
        cards_prize_reserve,
        funder_cards,
        cards_prize_vault,
        token_program,
        ..
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    assert_signer(authority)?;
    assert_writable(funder_cards)?;
    assert_writable(cards_prize_reserve)?;
    assert_writable(cards_prize_vault)?;
    assert_spl_token_program(token_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;
    let mut reserve = load_cards_prize_reserve(cards_prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        cards_prize_reserve,
        &[
            b"cards_prize_reserve",
            reserve.tournament_id.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        cards_prize_vault,
        &[b"cards_prize_vault", reserve.tournament_id.as_ref()],
        program_id,
    )?;
    require(
        spl_token_mint(funder_cards)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(funder_cards)? == reserve.funder,
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_mint(cards_prize_vault)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(cards_prize_vault)? == *cards_prize_reserve.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        reserve.status == PrizeStatus::Reserved as u8,
        ArenaError::InvalidPrizeStatus,
    )?;
    require(!reserve.winner_set, ArenaError::PrizeWinnerAlreadySet)?;

    let seeds_arr = seeds!(
        b"cards_prize_reserve",
        reserve.tournament_id.as_ref(),
        &bump_ref
    );
    let signer = Signer::from(&seeds_arr);
    spl_token_transfer_signed(
        cards_prize_vault,
        funder_cards,
        cards_prize_reserve,
        reserve.cards_amount,
        &[signer],
    )?;
    reserve.status = PrizeStatus::Released as u8;
    write_account_data(cards_prize_reserve, |d| reserve.pack(d))
}

pub fn process_claim_fee_vault(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [authority, config, fee_vault, destination, replay, system_program, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (claim_key, _) = read_bytes_arg::<32>(data, 0)?;
    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(fee_vault)?;
    assert_writable(destination)?;

    let cfg = load_config(config, program_id)?;
    if verify_pda(config, &[b"config"], program_id).is_err() {
        return Err(ArenaError::Unauthorized.into());
    }
    require(*authority.key() == cfg.authority, ArenaError::Unauthorized)?;
    require(*destination.key() == cfg.authority, ArenaError::Unauthorized)?;
    if !destination.is_owned_by(&SYSTEM_PROGRAM_ID) {
        return Err(ArenaError::Unauthorized.into());
    }
    require(*fee_vault.key() == cfg.fee_vault, ArenaError::Unauthorized)?;
    if verify_pda(fee_vault, &[b"fee_vault"], program_id).is_err() {
        return Err(ArenaError::Unauthorized.into());
    }
    require(cfg.buyback_bps <= BPS_DENOM, ArenaError::InvalidBps)?;

    let rent = Rent::get()?.minimum_balance(fee_vault.data_len());
    let balance = fee_vault.lamports();
    require(balance > rent, ArenaError::InsufficientFunds)?;
    let excess = balance.checked_sub(rent).ok_or(ArenaError::Overflow)?;
    let reserved = excess
        .checked_mul(cfg.buyback_bps)
        .ok_or(ArenaError::Overflow)?
        / BPS_DENOM;
    let claimable = excess.checked_sub(reserved).ok_or(ArenaError::Overflow)?;
    require(claimable > 0, ArenaError::InsufficientFunds)?;

    init_replay_account(
        authority,
        replay,
        system_program,
        program_id,
        &claim_key,
        ReplayKind::FeeVaultClaim as u8,
    )?;
    transfer_lamports_direct(fee_vault, destination, claimable)
}

pub fn process_init_cards_reward_vaults(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [payer, config, cards_mint, treasury_vault, operator_vault, token_program, system_program, ..] =
        accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    assert_signer(payer)?;
    assert_writable(payer)?;
    assert_spl_token_program(token_program)?;
    assert_system_program(system_program)?;
    let cfg = load_config(config, program_id)?;
    require(*payer.key() == cfg.authority, ArenaError::Unauthorized)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;

    let treasury_bump = verify_pda(treasury_vault, &[b"cards_treasury_vault"], program_id)?;
    let (treasury_authority, _) =
        pinocchio::pubkey::find_program_address(&[b"cards_treasury"], program_id);
    let treasury_bump_ref = [treasury_bump];
    let treasury_seeds = seeds!(b"cards_treasury_vault", &treasury_bump_ref);
    init_spl_token_account_pda(
        payer,
        treasury_vault,
        cards_mint,
        &treasury_authority,
        &[Signer::from(&treasury_seeds)],
    )?;

    let operator_bump = verify_pda(operator_vault, &[b"cards_operator_vault"], program_id)?;
    let (operator_authority, _) =
        pinocchio::pubkey::find_program_address(&[b"cards_operator"], program_id);
    let operator_bump_ref = [operator_bump];
    let operator_seeds = seeds!(b"cards_operator_vault", &operator_bump_ref);
    init_spl_token_account_pda(
        payer,
        operator_vault,
        cards_mint,
        &operator_authority,
        &[Signer::from(&operator_seeds)],
    )
}

pub fn process_claim_cards_operator(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        authority,
        config,
        cards_mint,
        operator_vault,
        destination,
        operator_authority,
        replay,
        token_program,
        system_program,
        ..
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (amount, off) = read_u64_arg(data, 0)?;
    let (claim_key, _) = read_bytes_arg::<32>(data, off)?;
    require(amount > 0, ArenaError::InvalidAmount)?;
    assert_signer(authority)?;
    assert_writable(authority)?;
    assert_writable(operator_vault)?;
    assert_writable(destination)?;
    assert_spl_token_program(token_program)?;

    let cfg = load_config(config, program_id)?;
    require(*authority.key() == cfg.authority, ArenaError::Unauthorized)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;
    verify_pda(operator_vault, &[b"cards_operator_vault"], program_id)?;
    verify_pda(operator_authority, &[b"cards_operator"], program_id)?;
    require(
        spl_token_mint(operator_vault)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(operator_vault)? == *operator_authority.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_mint(destination)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(destination)? == cfg.authority,
        ArenaError::Unauthorized,
    )?;
    let available = spl_token_amount(operator_vault)?;
    require(amount <= available, ArenaError::InsufficientFunds)?;

    init_replay_account(
        authority,
        replay,
        system_program,
        program_id,
        &claim_key,
        ReplayKind::CardsOperatorClaim as u8,
    )?;
    let bump = verify_pda(operator_authority, &[b"cards_operator"], program_id)?;
    let bump_ref = [bump];
    let seeds_arr = seeds!(b"cards_operator", &bump_ref);
    spl_token_transfer_signed(
        operator_vault,
        destination,
        operator_authority,
        amount,
        &[Signer::from(&seeds_arr)],
    )
}

pub fn process_fund_cards_prize_from_treasury(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    let [
        funding_authority,
        config,
        cards_mint,
        treasury_vault,
        treasury_authority,
        cards_prize_reserve,
        cards_prize_vault,
        replay,
        token_program,
        system_program,
        ..
    ] = accounts
    else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };
    let (tournament_id, off) = read_bytes_arg::<16>(data, 0)?;
    let (amount, off) = read_u64_arg(data, off)?;
    let (funding_key, _) = read_bytes_arg::<32>(data, off)?;
    require(amount > 0, ArenaError::InvalidAmount)?;
    assert_signer(funding_authority)?;
    assert_writable(funding_authority)?;
    assert_writable(treasury_vault)?;
    assert_writable(cards_prize_reserve)?;
    assert_writable(cards_prize_vault)?;
    assert_spl_token_program(token_program)?;
    assert_system_program(system_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(funding_authority, &cfg)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;
    verify_pda(treasury_vault, &[b"cards_treasury_vault"], program_id)?;
    verify_pda(treasury_authority, &[b"cards_treasury"], program_id)?;
    require(
        spl_token_mint(treasury_vault)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(treasury_vault)? == *treasury_authority.key(),
        ArenaError::Unauthorized,
    )?;
    let available = spl_token_amount(treasury_vault)?;
    require(amount <= available, ArenaError::InsufficientFunds)?;

    let reserve_bump = verify_pda(
        cards_prize_reserve,
        &[b"cards_prize_reserve", tournament_id.as_ref()],
        program_id,
    )?;
    let reserve_bump_ref = [reserve_bump];
    let reserve_seeds = seeds!(
        b"cards_prize_reserve",
        tournament_id.as_ref(),
        &reserve_bump_ref
    );
    create_account_signed(
        funding_authority,
        cards_prize_reserve,
        CARDS_PRIZE_RESERVE_SPACE,
        program_id,
        &[Signer::from(&reserve_seeds)],
    )?;

    let vault_bump = verify_pda(
        cards_prize_vault,
        &[b"cards_prize_vault", tournament_id.as_ref()],
        program_id,
    )?;
    let vault_bump_ref = [vault_bump];
    let vault_seeds = seeds!(
        b"cards_prize_vault",
        tournament_id.as_ref(),
        &vault_bump_ref
    );
    init_spl_token_account_pda(
        funding_authority,
        cards_prize_vault,
        cards_mint,
        cards_prize_reserve.key(),
        &[Signer::from(&vault_seeds)],
    )?;
    init_replay_account(
        funding_authority,
        replay,
        system_program,
        program_id,
        &funding_key,
        ReplayKind::CardsTreasuryFund as u8,
    )?;

    let reserve = CardsPrizeReserve {
        tournament_id,
        funder: *treasury_vault.key(),
        winner: Pubkey::default(),
        cards_amount: amount,
        status: PrizeStatus::Reserved as u8,
        winner_set: false,
        bump: reserve_bump,
        fund_key: funding_key,
        pay_key: [0u8; 32],
    };
    write_account_data(cards_prize_reserve, |d| reserve.pack(d))?;
    let authority_bump = verify_pda(treasury_authority, &[b"cards_treasury"], program_id)?;
    let authority_bump_ref = [authority_bump];
    let authority_seeds = seeds!(b"cards_treasury", &authority_bump_ref);
    spl_token_transfer_signed(
        treasury_vault,
        cards_prize_vault,
        treasury_authority,
        amount,
        &[Signer::from(&authority_seeds)],
    )
}

pub fn process_close_settled_match(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    if accounts.len() < 5 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let config = &accounts[1];
    let recipient = &accounts[2];
    let match_escrow = &accounts[3];
    let match_vault = &accounts[4];

    assert_signer(authority)?;
    assert_writable(recipient)?;
    assert_writable(match_escrow)?;
    assert_writable(match_vault)?;
    assert_system_account(recipient)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;

    let escrow = load_match_escrow(match_escrow, program_id)?;
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
    require(*recipient.key() == escrow.creator, ArenaError::Unauthorized)?;

    let settled = escrow.status == MatchStatus::Settled as u8;
    let cancelled = escrow.status == MatchStatus::Cancelled as u8
        && !escrow.creator_deposited
        && !escrow.opponent_deposited;
    require(settled || cancelled, ArenaError::InvalidMatchStatus)?;
    if settled {
        require(escrow.fee_charged, ArenaError::FeeNotCharged)?;
    }
    assert_rent_only(match_escrow)?;
    assert_rent_only(match_vault)?;

    if settled {
        let replay = accounts.get(5).ok_or(ProgramError::NotEnoughAccountKeys)?;
        require_replay(
            replay,
            program_id,
            &escrow.settlement_key,
            &[ReplayKind::MatchWin as u8, ReplayKind::MatchTie as u8],
        )?;
        close_rent_account(replay, recipient)?;
    } else {
        require(
            !key_is_set(&escrow.settlement_key),
            ArenaError::Unauthorized,
        )?;
    }

    close_rent_account(match_vault, recipient)?;
    close_rent_account(match_escrow, recipient)
}

pub fn process_close_final_cards_prize(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    if accounts.len() < 8 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let config = &accounts[1];
    let recipient = &accounts[2];
    let cards_mint = &accounts[3];
    let cards_prize_reserve = &accounts[4];
    let cards_prize_vault = &accounts[5];
    let token_program = &accounts[6];

    assert_signer(authority)?;
    assert_writable(recipient)?;
    assert_writable(cards_prize_reserve)?;
    assert_writable(cards_prize_vault)?;
    assert_system_account(recipient)?;
    assert_spl_token_program(token_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    assert_cards_mint_account(cards_mint)?;
    require(*cards_mint.key() == cfg.cards_mint, ArenaError::Unauthorized)?;
    require(*recipient.key() == cfg.authority, ArenaError::Unauthorized)?;

    let reserve = load_cards_prize_reserve(cards_prize_reserve, program_id)?;
    let bump_ref = [reserve.bump];
    verify_pda_with_bump(
        cards_prize_reserve,
        &[
            b"cards_prize_reserve",
            reserve.tournament_id.as_ref(),
            &bump_ref,
        ],
        program_id,
    )?;
    verify_pda(
        cards_prize_vault,
        &[b"cards_prize_vault", reserve.tournament_id.as_ref()],
        program_id,
    )?;
    require(
        spl_token_mint(cards_prize_vault)? == *cards_mint.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_owner(cards_prize_vault)? == *cards_prize_reserve.key(),
        ArenaError::Unauthorized,
    )?;
    require(
        spl_token_amount(cards_prize_vault)? == 0,
        ArenaError::BalanceRemaining,
    )?;

    let paid = reserve.status == PrizeStatus::Paid as u8;
    let released = reserve.status == PrizeStatus::Released as u8;
    require(paid || released, ArenaError::InvalidPrizeStatus)?;
    assert_rent_only(cards_prize_vault)?;
    assert_rent_only(cards_prize_reserve)?;

    let fund_replay = accounts.get(7).ok_or(ProgramError::NotEnoughAccountKeys)?;
    require_replay(
        fund_replay,
        program_id,
        &reserve.fund_key,
        &[
            ReplayKind::CardsPrizeFund as u8,
            ReplayKind::CardsTreasuryFund as u8,
        ],
    )?;

    let seeds_arr = seeds!(
        b"cards_prize_reserve",
        reserve.tournament_id.as_ref(),
        &bump_ref
    );
    let signer = Signer::from(&seeds_arr);
    spl_close_account_signed(
        cards_prize_vault,
        recipient,
        cards_prize_reserve,
        &[signer],
    )?;
    if paid {
        require(key_is_set(&reserve.pay_key), ArenaError::Unauthorized)?;
        let pay_replay = accounts.get(8).ok_or(ProgramError::NotEnoughAccountKeys)?;
        require_replay(
            pay_replay,
            program_id,
            &reserve.pay_key,
            &[ReplayKind::CardsPrizePay as u8],
        )?;
        close_rent_account(pay_replay, recipient)?;
    } else {
        require(!key_is_set(&reserve.pay_key), ArenaError::Unauthorized)?;
    }
    close_rent_account(fund_replay, recipient)?;
    close_rent_account(cards_prize_reserve, recipient)
}

pub fn process_claim_operator_fees(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    let [authority, config, operator_vault, destination, ..] = accounts else {
        return Err(ProgramError::NotEnoughAccountKeys);
    };

    assert_signer(authority)?;
    assert_writable(operator_vault)?;
    assert_writable(destination)?;

    let cfg = load_config(config, program_id)?;
    if verify_pda(config, &[b"config"], program_id).is_err() {
        return Err(ArenaError::Unauthorized.into());
    }
    require(*authority.key() == cfg.authority, ArenaError::Unauthorized)?;
    require(*destination.key() == cfg.authority, ArenaError::Unauthorized)?;
    if !destination.is_owned_by(&SYSTEM_PROGRAM_ID) {
        return Err(ArenaError::Unauthorized.into());
    }
    if verify_pda(operator_vault, &[b"operator_vault"], program_id).is_err() {
        return Err(ArenaError::Unauthorized.into());
    }
    require(
        *operator_vault.key() == cfg.operator_vault,
        ArenaError::Unauthorized,
    )?;
    if !operator_vault.is_owned_by(program_id) {
        return Err(ArenaError::Unauthorized.into());
    }

    let rent = Rent::get()?.minimum_balance(operator_vault.data_len());
    let balance = operator_vault.lamports();
    require(balance > rent, ArenaError::InsufficientFunds)?;
    let withdrawable = balance.checked_sub(rent).ok_or(ArenaError::Overflow)?;
    transfer_lamports_direct(operator_vault, destination, withdrawable)
}

pub fn process_close_final_entry(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
) -> ProgramResult {
    if accounts.len() < 6 {
        return Err(ProgramError::NotEnoughAccountKeys);
    }
    let authority = &accounts[0];
    let config = &accounts[1];
    let recipient = &accounts[2];
    let entry_escrow = &accounts[3];
    let entry_vault = &accounts[4];
    let token_program = &accounts[5];

    assert_signer(authority)?;
    assert_writable(recipient)?;
    assert_writable(entry_escrow)?;
    assert_writable(entry_vault)?;
    assert_system_account(recipient)?;
    assert_token_program(token_program)?;

    let cfg = load_config(config, program_id)?;
    authority_or_keeper(authority, &cfg)?;
    require_poke_configured(&cfg)?;

    let entry = load_entry_escrow(entry_escrow, program_id)?;
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
    require(*recipient.key() == entry.player, ArenaError::Unauthorized)?;
    require(token_mint(entry_vault)? == cfg.poke_mint, ArenaError::Unauthorized)?;
    require(
        token_owner(entry_vault)? == *entry_escrow.key(),
        ArenaError::Unauthorized,
    )?;
    require(token_amount(entry_vault)? == 0, ArenaError::BalanceRemaining)?;

    let burned = entry.status == EntryStatus::Burned as u8;
    let refunded = entry.status == EntryStatus::Refunded as u8;
    require(burned || refunded, ArenaError::InvalidEntryStatus)?;
    assert_rent_only(entry_vault)?;
    assert_rent_only(entry_escrow)?;

    let seeds_arr = seeds!(
        b"entry_escrow",
        entry.tournament_id.as_ref(),
        entry.player.as_ref(),
        &bump_ref
    );
    let signer = Signer::from(&seeds_arr);
    close_token_account_signed(
        token_program.key(),
        entry_vault,
        recipient,
        entry_escrow,
        &[signer],
    )?;

    if burned {
        let replay = accounts.get(6).ok_or(ProgramError::NotEnoughAccountKeys)?;
        require_replay(
            replay,
            program_id,
            &entry.burn_key,
            &[ReplayKind::EntryBurn as u8],
        )?;
        close_rent_account(replay, recipient)?;
    } else {
        require(!key_is_set(&entry.burn_key), ArenaError::Unauthorized)?;
    }
    close_rent_account(entry_escrow, recipient)
}
