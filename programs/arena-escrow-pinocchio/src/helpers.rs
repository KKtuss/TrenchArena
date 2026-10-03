use pinocchio::{
    account_info::AccountInfo,
    instruction::Signer,
    program_error::ProgramError,
    pubkey::{create_program_address, find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{CreateAccount, Transfer as SystemTransfer};
use pinocchio_token::instructions::{
    Burn, InitializeAccount3, Transfer as TokenTransfer,
};

use crate::{
    error::ArenaError,
    state::{Config, TOKEN_ACCOUNT_SPACE},
};

pub const SYSTEM_PROGRAM_ID: Pubkey = pinocchio_system::ID;
pub const TOKEN_PROGRAM_ID: Pubkey = pinocchio_token::ID;

#[inline(always)]
pub fn assert_signer(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_signer() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    Ok(())
}

#[inline(always)]
pub fn assert_writable(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.is_writable() {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

#[inline(always)]
pub fn assert_owned_by(account: &AccountInfo, owner: &Pubkey) -> Result<(), ProgramError> {
    if !account.is_owned_by(owner) {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

#[inline(always)]
pub fn assert_system_account(account: &AccountInfo) -> Result<(), ProgramError> {
    assert_owned_by(account, &SYSTEM_PROGRAM_ID)
}

#[inline(always)]
pub fn assert_token_program(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key() != &TOKEN_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

#[inline(always)]
pub fn assert_system_program(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key() != &SYSTEM_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

#[inline(always)]
pub fn authority_or_keeper(
    authority: &AccountInfo,
    config: &Config,
) -> Result<(), ProgramError> {
    let key = authority.key();
    if key != &config.authority && key != &config.keeper {
        return Err(ArenaError::Unauthorized.into());
    }
    Ok(())
}

/// Verify PDA via `find_program_address` (Anchor `bump` without stored value).
#[inline(always)]
pub fn verify_pda(
    account: &AccountInfo,
    seeds: &[&[u8]],
    program_id: &Pubkey,
) -> Result<u8, ProgramError> {
    let (expected, bump) = find_program_address(seeds, program_id);
    if account.key() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(bump)
}

/// Verify PDA via `create_program_address` with a known bump.
#[inline(always)]
pub fn verify_pda_with_bump(
    account: &AccountInfo,
    seeds_with_bump: &[&[u8]],
    program_id: &Pubkey,
) -> Result<(), ProgramError> {
    let expected = create_program_address(seeds_with_bump, program_id)?;
    if account.key() != &expected {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok(())
}

#[inline(always)]
pub fn rent_minimum_balance(space: usize) -> Result<u64, ProgramError> {
    Ok(Rent::get()?.minimum_balance(space))
}

/// Anchor `init`: reject accounts that already hold program-owned data.
#[inline(always)]
pub fn assert_uninitialized(account: &AccountInfo) -> Result<(), ProgramError> {
    if !account.data_is_empty() {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    Ok(())
}

pub fn create_account_signed(
    payer: &AccountInfo,
    account: &AccountInfo,
    space: usize,
    owner: &Pubkey,
    signer_seeds: &[Signer],
) -> ProgramResult {
    assert_writable(payer)?;
    assert_writable(account)?;
    assert_signer(payer)?;
    assert_uninitialized(account)?;

    let lamports = rent_minimum_balance(space)?;
    CreateAccount {
        from: payer,
        to: account,
        lamports,
        space: space as u64,
        owner,
    }
    .invoke_signed(signer_seeds)
}

pub fn transfer_lamports_direct(
    from: &AccountInfo,
    to: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    assert_writable(from)?;
    assert_writable(to)?;
    let mut from_lams = from.try_borrow_mut_lamports()?;
    let mut to_lams = to.try_borrow_mut_lamports()?;
    *from_lams = from_lams
        .checked_sub(amount)
        .ok_or(ProgramError::InsufficientFunds)?;
    *to_lams = to_lams
        .checked_add(amount)
        .ok_or(ArenaError::Overflow)?;
    Ok(())
}

pub fn system_transfer(from: &AccountInfo, to: &AccountInfo, lamports: u64) -> ProgramResult {
    assert_signer(from)?;
    assert_writable(from)?;
    assert_writable(to)?;
    SystemTransfer {
        from,
        to,
        lamports,
    }
    .invoke()
}

pub fn token_transfer(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke()
}

pub fn token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[Signer],
) -> ProgramResult {
    TokenTransfer {
        from,
        to,
        authority,
        amount,
    }
    .invoke_signed(signer_seeds)
}

pub fn token_burn(
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    Burn {
        account,
        mint,
        authority,
        amount,
    }
    .invoke()
}

pub fn token_burn_signed(
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[Signer],
) -> ProgramResult {
    Burn {
        account,
        mint,
        authority,
        amount,
    }
    .invoke_signed(signer_seeds)
}

pub fn write_account_data(
    account: &AccountInfo,
    pack_fn: impl FnOnce(&mut [u8]) -> Result<(), ProgramError>,
) -> ProgramResult {
    let mut data = account.try_borrow_mut_data()?;
    pack_fn(&mut data)
}

pub fn load_config(account: &AccountInfo, program_id: &Pubkey) -> Result<Config, ProgramError> {
    assert_owned_by(account, program_id)?;
    let data = account.try_borrow_data()?;
    Config::unpack(&data)
}

#[inline(always)]
pub fn token_mint(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    assert_owned_by(account, &TOKEN_PROGRAM_ID)?;
    let data = account.try_borrow_data()?;
    if data.len() < 32 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut mint = [0u8; 32];
    mint.copy_from_slice(&data[0..32]);
    Ok(mint)
}

#[inline(always)]
pub fn token_owner(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    assert_owned_by(account, &TOKEN_PROGRAM_ID)?;
    let data = account.try_borrow_data()?;
    if data.len() < 64 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut owner = [0u8; 32];
    owner.copy_from_slice(&data[32..64]);
    Ok(owner)
}

#[inline(always)]
pub fn token_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    assert_owned_by(account, &TOKEN_PROGRAM_ID)?;
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

pub fn assert_mint_account(mint: &AccountInfo) -> Result<(), ProgramError> {
    assert_owned_by(mint, &TOKEN_PROGRAM_ID)?;
    if mint.data_len() < 82 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Create + InitializeAccount3 for an SPL token PDA vault.
pub fn init_token_account_pda(
    payer: &AccountInfo,
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &Pubkey,
    signer_seeds: &[Signer],
) -> ProgramResult {
    create_account_signed(
        payer,
        account,
        TOKEN_ACCOUNT_SPACE,
        &TOKEN_PROGRAM_ID,
        signer_seeds,
    )?;
    InitializeAccount3 {
        account,
        mint,
        owner: authority,
    }
    .invoke()
}

#[inline(always)]
pub fn read_u64_arg(data: &[u8], offset: usize) -> Result<(u64, usize), ProgramError> {
    if data.len() < offset + 8 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let v = u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap());
    Ok((v, offset + 8))
}

#[inline(always)]
pub fn read_bytes_arg<const N: usize>(
    data: &[u8],
    offset: usize,
) -> Result<([u8; N], usize), ProgramError> {
    if data.len() < offset + N {
        return Err(ProgramError::InvalidInstructionData);
    }
    let mut out = [0u8; N];
    out.copy_from_slice(&data[offset..offset + N]);
    Ok((out, offset + N))
}

#[inline(always)]
pub fn read_u8_arg(data: &[u8], offset: usize) -> Result<(u8, usize), ProgramError> {
    if data.len() < offset + 1 {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok((data[offset], offset + 1))
}
