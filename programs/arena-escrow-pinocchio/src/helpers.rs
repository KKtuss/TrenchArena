use pinocchio::{
    account_info::AccountInfo,
    instruction::{AccountMeta, Instruction, Signer},
    program::slice_invoke_signed,
    program_error::ProgramError,
    pubkey::{create_program_address, find_program_address, Pubkey},
    sysvars::{rent::Rent, Sysvar},
    ProgramResult,
};
use pinocchio_system::instructions::{CreateAccount, Transfer as SystemTransfer};
use pinocchio_token::instructions::{
    CloseAccount, InitializeAccount3, Transfer as TokenTransfer,
};

use crate::{
    error::ArenaError,
    state::{Config, POKE_MINT_DECIMALS, TOKEN_ACCOUNT_SPACE},
};

pub const SYSTEM_PROGRAM_ID: Pubkey = pinocchio_system::ID;
/// Classic SPL Token (Tokenkeg). CARDS accounts and CARDS CPIs use this.
pub const TOKEN_PROGRAM_ID: Pubkey = pinocchio_token::ID;
/// Token-2022 (TokenzQd...). POKE accounts and POKE CPIs use this.
pub const TOKEN_2022_PROGRAM_ID: Pubkey = [
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77,
    131, 185, 13, 39, 254, 189, 249, 40, 216, 161, 139, 252,
];

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
/// POKE instructions must name Token-2022.
pub fn assert_token_program(account: &AccountInfo) -> Result<(), ProgramError> {
    if account.key() != &TOKEN_2022_PROGRAM_ID {
        return Err(ProgramError::IncorrectProgramId);
    }
    Ok(())
}

/// CARDS instructions must name classic SPL Token.
pub fn assert_spl_token_program(account: &AccountInfo) -> Result<(), ProgramError> {
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

fn invoke_token(
    program_id: &Pubkey,
    metas: &[AccountMeta],
    data: &[u8],
    accounts: &[&AccountInfo],
    signers: &[Signer],
) -> ProgramResult {
    let instruction = Instruction {
        program_id,
        accounts: metas,
        data,
    };
    slice_invoke_signed(&instruction, accounts, signers)
}

pub fn token_transfer(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    token_transfer_with(&TOKEN_2022_PROGRAM_ID, from, to, authority, amount, &[])
}

pub fn token_transfer_signed(
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[Signer],
) -> ProgramResult {
    token_transfer_with(
        &TOKEN_2022_PROGRAM_ID,
        from,
        to,
        authority,
        amount,
        signer_seeds,
    )
}

fn token_transfer_with(
    program_id: &Pubkey,
    from: &AccountInfo,
    to: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[Signer],
) -> ProgramResult {
    let metas = [
        AccountMeta::writable(from.key()),
        AccountMeta::writable(to.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let mut data = [0u8; 9];
    data[0] = 3;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    invoke_token(program_id, &metas, &data, &[from, to, authority], signer_seeds)
}

pub fn token_burn(
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
) -> ProgramResult {
    token_burn_with(&TOKEN_2022_PROGRAM_ID, account, mint, authority, amount, &[])
}

pub fn token_burn_signed(
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[Signer],
) -> ProgramResult {
    token_burn_with(
        &TOKEN_2022_PROGRAM_ID,
        account,
        mint,
        authority,
        amount,
        signer_seeds,
    )
}

fn token_burn_with(
    program_id: &Pubkey,
    account: &AccountInfo,
    mint: &AccountInfo,
    authority: &AccountInfo,
    amount: u64,
    signer_seeds: &[Signer],
) -> ProgramResult {
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::writable(mint.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let mut data = [0u8; 9];
    data[0] = 8;
    data[1..9].copy_from_slice(&amount.to_le_bytes());
    invoke_token(
        program_id,
        &metas,
        &data,
        &[account, mint, authority],
        signer_seeds,
    )
}

pub fn spl_token_transfer(
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

pub fn spl_token_transfer_signed(
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

/// SPL CloseAccount (discriminator 9) for Tokenkeg or Token-2022.
pub fn close_token_account_signed(
    token_program_id: &Pubkey,
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[Signer],
) -> ProgramResult {
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::writable(destination.key()),
        AccountMeta::readonly_signer(authority.key()),
    ];
    let data = [9u8];
    invoke_token(
        token_program_id,
        &metas,
        &data,
        &[account, destination, authority],
        signer_seeds,
    )
}

pub fn spl_close_account_signed(
    account: &AccountInfo,
    destination: &AccountInfo,
    authority: &AccountInfo,
    signer_seeds: &[Signer],
) -> ProgramResult {
    CloseAccount {
        account,
        destination,
        authority,
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
    read_token_pubkey(account, &TOKEN_2022_PROGRAM_ID, 0)
}

#[inline(always)]
pub fn token_owner(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    read_token_pubkey(account, &TOKEN_2022_PROGRAM_ID, 32)
}

#[inline(always)]
pub fn token_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    read_token_amount(account, &TOKEN_2022_PROGRAM_ID)
}

pub fn spl_token_mint(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    read_token_pubkey(account, &TOKEN_PROGRAM_ID, 0)
}

pub fn spl_token_owner(account: &AccountInfo) -> Result<Pubkey, ProgramError> {
    read_token_pubkey(account, &TOKEN_PROGRAM_ID, 32)
}

pub fn spl_token_amount(account: &AccountInfo) -> Result<u64, ProgramError> {
    read_token_amount(account, &TOKEN_PROGRAM_ID)
}

fn read_token_pubkey(
    account: &AccountInfo,
    owner: &Pubkey,
    offset: usize,
) -> Result<Pubkey, ProgramError> {
    assert_owned_by(account, owner)?;
    let data = account.try_borrow_data()?;
    if data.len() < offset + 32 {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut key = [0u8; 32];
    key.copy_from_slice(&data[offset..offset + 32]);
    Ok(key)
}

fn read_token_amount(account: &AccountInfo, owner: &Pubkey) -> Result<u64, ProgramError> {
    assert_owned_by(account, owner)?;
    let data = account.try_borrow_data()?;
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(u64::from_le_bytes(data[64..72].try_into().unwrap()))
}

const MINT_BASE: usize = 82;
const ACCOUNT_TYPE_AT: usize = 165;
const TLV_AT: usize = 166;
const MAX_POKE_MINT: usize = 1024;
const MINT_ACCOUNT_TYPE: u8 = 1;
const EXT_METADATA_POINTER: u16 = 18;
const EXT_TOKEN_METADATA: u16 = 19;
const POINTER_LEN: usize = 64;

/// Token-2022 POKE mint.
/// A bare 82-byte mint is accepted. A larger mint is accepted only when it is
/// the launch layout: account type Mint, zero padding, MetadataPointer (64
/// bytes) and TokenMetadata, and no other extension. MetadataPointer and
/// TokenMetadata do not add accounts to Transfer or Burn.
pub fn assert_poke_mint_account(mint: &AccountInfo) -> Result<(), ProgramError> {
    assert_owned_by(mint, &TOKEN_2022_PROGRAM_ID)?;
    let data = mint.try_borrow_data()?;
    let len = data.len();
    if len < MINT_BASE || len > MAX_POKE_MINT || data[44] != POKE_MINT_DECIMALS || data[45] != 1 {
        return Err(ProgramError::InvalidAccountData);
    }
    if len == MINT_BASE {
        return Ok(());
    }
    if len < TLV_AT || data[ACCOUNT_TYPE_AT] != MINT_ACCOUNT_TYPE {
        return Err(ProgramError::InvalidAccountData);
    }
    let mut index = MINT_BASE;
    while index < ACCOUNT_TYPE_AT {
        if data[index] != 0 {
            return Err(ProgramError::InvalidAccountData);
        }
        index += 1;
    }
    let mut offset = TLV_AT;
    let mut pointer = false;
    let mut metadata = false;
    while offset < len {
        if len - offset < 4 {
            return Err(ProgramError::InvalidAccountData);
        }
        let kind = u16::from_le_bytes([data[offset], data[offset + 1]]);
        let ext_len = u16::from_le_bytes([data[offset + 2], data[offset + 3]]) as usize;
        let next = offset + 4 + ext_len;
        if next > len {
            return Err(ProgramError::InvalidAccountData);
        }
        if kind == EXT_METADATA_POINTER {
            if pointer || ext_len != POINTER_LEN {
                return Err(ProgramError::InvalidAccountData);
            }
            pointer = true;
        } else if kind == EXT_TOKEN_METADATA {
            if metadata || ext_len == 0 {
                return Err(ProgramError::InvalidAccountData);
            }
            metadata = true;
        } else {
            return Err(ProgramError::InvalidAccountData);
        }
        offset = next;
    }
    if !pointer || !metadata {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

pub fn assert_mint_account(mint: &AccountInfo) -> Result<(), ProgramError> {
    assert_poke_mint_account(mint)
}

pub fn assert_spl_mint_account(mint: &AccountInfo) -> Result<(), ProgramError> {
    assert_owned_by(mint, &TOKEN_PROGRAM_ID)?;
    if mint.data_len() < 82 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

/// Create + InitializeAccount3 for a Token-2022 PDA vault (POKE).
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
        &TOKEN_2022_PROGRAM_ID,
        signer_seeds,
    )?;
    initialize_account3(&TOKEN_2022_PROGRAM_ID, account, mint, authority)
}

/// Create + InitializeAccount3 for a classic SPL PDA vault (CARDS).
pub fn init_spl_token_account_pda(
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

fn initialize_account3(
    program_id: &Pubkey,
    account: &AccountInfo,
    mint: &AccountInfo,
    owner: &Pubkey,
) -> ProgramResult {
    let metas = [
        AccountMeta::writable(account.key()),
        AccountMeta::readonly(mint.key()),
    ];
    let mut data = [0u8; 33];
    data[0] = 18;
    data[1..33].copy_from_slice(owner);
    invoke_token(program_id, &metas, &data, &[account, mint], &[])
}

pub fn close_program_account(account: &AccountInfo, recipient: &AccountInfo) -> ProgramResult {
    if account.key() == recipient.key() {
        return Err(ProgramError::InvalidAccountData);
    }
    let amount = account.lamports();
    if amount > 0 {
        transfer_lamports_direct(account, recipient, amount)?;
    }
    account.close()
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
