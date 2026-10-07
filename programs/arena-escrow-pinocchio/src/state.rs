use pinocchio::{program_error::ProgramError, pubkey::Pubkey};

use crate::error::ArenaError;

pub const CASUAL_FEE_BPS: u64 = 200;
pub const TREASURY_BPS: u64 = 9000;
pub const OPERATOR_BPS: u64 = 1000;
pub const BPS_DENOM: u64 = 10_000;
pub const POKE_MINT_DECIMALS: u8 = 6;
pub const CARDS_MINT_DECIMALS: u8 = 6;
/// Exactly 10,000 POKE at 6 decimals. Passport USD value is a separate check.
pub const TOURNAMENT_ENTRY_ATOMS: u64 = 10_000_000_000;

pub const CONFIG_DISCRIMINATOR: [u8; 8] = [0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82];
pub const MATCH_ESCROW_DISCRIMINATOR: [u8; 8] = [0x29, 0xfd, 0xf5, 0x95, 0x07, 0xf3, 0xcb, 0x8b];
pub const ENTRY_ESCROW_DISCRIMINATOR: [u8; 8] = [0x73, 0x99, 0x14, 0x2d, 0xe2, 0xce, 0x8b, 0xf4];
pub const PRIZE_RESERVE_DISCRIMINATOR: [u8; 8] = [0xa0, 0x94, 0xbb, 0xf2, 0x2b, 0x20, 0x7b, 0x32];
pub const REPLAY_DISCRIMINATOR: [u8; 8] = [0x26, 0xe4, 0xcc, 0x2e, 0xfb, 0x1c, 0x7c, 0x69];
pub const TREASURY_DEPOSIT_DISCRIMINATOR: [u8; 8] =
    [0xc3, 0xa0, 0x6e, 0x76, 0x52, 0x6f, 0xe7, 0xae];

/// 273-byte prefix (through `bump`) plus the CARDS mint pubkey at offset 273.
pub const CONFIG_SPACE: usize = 8 + 32 * 7 + 8 * 5 + 1 + 32; // 305
pub const CONFIG_PREFIX_SPACE: usize = 273;
/// Includes the 32-byte settlement replay key used by `close_settled_match`.
pub const MATCH_ESCROW_SPACE: usize = 8 + 16 + 32 * 2 + 8 + 1 * 4 + 1 + 32; // 133
/// Includes the 32-byte burn replay key used by `close_final_entry`.
pub const ENTRY_ESCROW_SPACE: usize = 8 + 16 + 32 + 8 + 32 + 8 + 1 + 1 + 32; // 138
pub const PRIZE_RESERVE_SPACE: usize = 8 + 16 + 32 + 8 + 1 + 1 + 1; // 67
/// 8 + 16 + 32 + 32 + 8 + 1 + 1 + 1 + 32 + 32. The last two pubkeys are replay keys.
pub const CARDS_PRIZE_RESERVE_SPACE: usize = 163;
pub const CARDS_PRIZE_RESERVE_DISCRIMINATOR: [u8; 8] =
    [0xb5, 0x15, 0x86, 0x05, 0x7d, 0x1d, 0x88, 0xb1];
pub const REPLAY_SPACE: usize = 8 + 32 + 1 + 1; // 42
pub const TREASURY_DEPOSIT_SPACE: usize = 8 + 32 + 8 * 3 + 1; // 65
pub const UNCHECKED_VAULT_SPACE: usize = 8;
pub const TOKEN_ACCOUNT_SPACE: usize = 165;

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatchStatus {
    Open = 0,
    Funding = 1,
    Funded = 2,
    Active = 3,
    Settled = 4,
    Cancelled = 5,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum EntryStatus {
    Reserved = 0,
    Burned = 1,
    Refunded = 2,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PrizeStatus {
    Reserved = 0,
    Paid = 1,
    Released = 2,
}

#[repr(u8)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplayKind {
    MatchWin = 0,
    MatchTie = 1,
    EntryBurn = 2,
    TreasuryDeposit = 3,
    PrizePay = 4,
    BuybackBurn = 5,
    CardsPrizeFund = 6,
    CardsPrizePay = 7,
    FeeVaultClaim = 8,
    CardsOperatorClaim = 9,
    CardsTreasuryFund = 10,
}

#[derive(Clone, Copy, Debug)]
pub struct Config {
    pub authority: Pubkey,
    pub fee_vault: Pubkey,
    pub treasury_vault: Pubkey,
    pub operator_vault: Pubkey,
    pub poke_mint: Pubkey,
    pub quote_authority: Pubkey,
    pub keeper: Pubkey,
    pub fee_bps: u64,
    pub treasury_bps: u64,
    pub operator_bps: u64,
    pub buyback_bps: u64,
    pub min_buyback_lamports: u64,
    pub bump: u8,
    /// Classic SPL CARDS mint. Zero until `set_cards_mint`. Stored at offset 273.
    pub cards_mint: Pubkey,
}

#[derive(Clone, Copy, Debug)]
pub struct MatchEscrow {
    pub room_id: [u8; 16],
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub collateral_lamports: u64,
    pub creator_deposited: bool,
    pub opponent_deposited: bool,
    pub fee_charged: bool,
    pub status: u8,
    pub bump: u8,
    /// Settlement replay key. Zero until the match is settled.
    pub settlement_key: [u8; 32],
}

#[derive(Clone, Copy, Debug)]
pub struct EntryEscrow {
    pub tournament_id: [u8; 16],
    pub player: Pubkey,
    pub amount: u64,
    pub quote_id: [u8; 32],
    pub price_micro_usd: u64,
    pub status: u8,
    pub bump: u8,
    /// Burn replay key. Zero until the entry is burned.
    pub burn_key: [u8; 32],
}

#[derive(Clone, Copy, Debug)]
pub struct PrizeReserve {
    pub tournament_id: [u8; 16],
    pub winner: Pubkey,
    pub amount: u64,
    pub status: u8,
    pub winner_set: bool,
    pub bump: u8,
}

/// Staging Pinocchio CARDS prize reserve. Offsets through the bump match the client.
///
/// ```text
/// 0    discriminator b51586057d1d88b1
/// 8    tournament_id [u8; 16]
/// 24   funder
/// 56   winner
/// 88   cards_amount u64
/// 96   status (0 reserved, 1 paid, 2 released)
/// 97   winner_set
/// 98   bump
/// 99   fund_key [u8; 32]
/// 131  pay_key [u8; 32]  zero until pay
/// ```
#[derive(Clone, Copy, Debug)]
pub struct CardsPrizeReserve {
    pub tournament_id: [u8; 16],
    pub funder: Pubkey,
    pub winner: Pubkey,
    pub cards_amount: u64,
    pub status: u8,
    pub winner_set: bool,
    pub bump: u8,
    pub fund_key: [u8; 32],
    pub pay_key: [u8; 32],
}

#[derive(Clone, Copy, Debug)]
pub struct Replay {
    pub key: [u8; 32],
    pub kind: u8,
    pub bump: u8,
}

#[derive(Clone, Copy, Debug)]
pub struct TreasuryDeposit {
    pub claim_key: [u8; 32],
    pub gross_lamports: u64,
    pub treasury_lamports: u64,
    pub operator_lamports: u64,
    pub bump: u8,
}

#[inline(always)]
fn read_pubkey(data: &[u8], offset: usize) -> Pubkey {
    let mut pk = [0u8; 32];
    pk.copy_from_slice(&data[offset..offset + 32]);
    pk
}

#[inline(always)]
fn write_pubkey(dst: &mut [u8], offset: usize, pk: &Pubkey) {
    dst[offset..offset + 32].copy_from_slice(pk);
}

#[inline(always)]
fn read_u64(data: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(data[offset..offset + 8].try_into().unwrap())
}

#[inline(always)]
fn write_u64(dst: &mut [u8], offset: usize, value: u64) {
    dst[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}

#[inline(always)]
fn require_disc(data: &[u8], expected: &[u8; 8]) -> Result<(), ProgramError> {
    if data.len() < 8 || data[0..8] != expected[..] {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(())
}

impl Config {
    pub const LEN: usize = CONFIG_SPACE;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&CONFIG_DISCRIMINATOR);
        write_pubkey(dst, 8, &self.authority);
        write_pubkey(dst, 40, &self.fee_vault);
        write_pubkey(dst, 72, &self.treasury_vault);
        write_pubkey(dst, 104, &self.operator_vault);
        write_pubkey(dst, 136, &self.poke_mint);
        write_pubkey(dst, 168, &self.quote_authority);
        write_pubkey(dst, 200, &self.keeper);
        write_u64(dst, 232, self.fee_bps);
        write_u64(dst, 240, self.treasury_bps);
        write_u64(dst, 248, self.operator_bps);
        write_u64(dst, 256, self.buyback_bps);
        write_u64(dst, 264, self.min_buyback_lamports);
        dst[272] = self.bump;
        write_pubkey(dst, 273, &self.cards_mint);
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        // Offsets 0..273 are the original config. CARDS mint is appended at 273.
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &CONFIG_DISCRIMINATOR)?;
        Ok(Self {
            authority: read_pubkey(data, 8),
            fee_vault: read_pubkey(data, 40),
            treasury_vault: read_pubkey(data, 72),
            operator_vault: read_pubkey(data, 104),
            poke_mint: read_pubkey(data, 136),
            quote_authority: read_pubkey(data, 168),
            keeper: read_pubkey(data, 200),
            fee_bps: read_u64(data, 232),
            treasury_bps: read_u64(data, 240),
            operator_bps: read_u64(data, 248),
            buyback_bps: read_u64(data, 256),
            min_buyback_lamports: read_u64(data, 264),
            bump: data[272],
            cards_mint: read_pubkey(data, 273),
        })
    }
}

impl MatchEscrow {
    pub const LEN: usize = MATCH_ESCROW_SPACE;
    pub const DATA_LEN: usize = 133;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::DATA_LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&MATCH_ESCROW_DISCRIMINATOR);
        dst[8..24].copy_from_slice(&self.room_id);
        write_pubkey(dst, 24, &self.creator);
        write_pubkey(dst, 56, &self.opponent);
        write_u64(dst, 88, self.collateral_lamports);
        dst[96] = self.creator_deposited as u8;
        dst[97] = self.opponent_deposited as u8;
        dst[98] = self.fee_charged as u8;
        dst[99] = self.status;
        dst[100] = self.bump;
        dst[101..133].copy_from_slice(&self.settlement_key);
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::DATA_LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &MATCH_ESCROW_DISCRIMINATOR)?;
        let mut room_id = [0u8; 16];
        room_id.copy_from_slice(&data[8..24]);
        Ok(Self {
            room_id,
            creator: read_pubkey(data, 24),
            opponent: read_pubkey(data, 56),
            collateral_lamports: read_u64(data, 88),
            creator_deposited: data[96] != 0,
            opponent_deposited: data[97] != 0,
            fee_charged: data[98] != 0,
            status: data[99],
            bump: data[100],
            settlement_key: data[101..133].try_into().unwrap(),
        })
    }
}

impl EntryEscrow {
    pub const LEN: usize = ENTRY_ESCROW_SPACE;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&ENTRY_ESCROW_DISCRIMINATOR);
        dst[8..24].copy_from_slice(&self.tournament_id);
        write_pubkey(dst, 24, &self.player);
        write_u64(dst, 56, self.amount);
        dst[64..96].copy_from_slice(&self.quote_id);
        write_u64(dst, 96, self.price_micro_usd);
        dst[104] = self.status;
        dst[105] = self.bump;
        dst[106..138].copy_from_slice(&self.burn_key);
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &ENTRY_ESCROW_DISCRIMINATOR)?;
        let mut tournament_id = [0u8; 16];
        tournament_id.copy_from_slice(&data[8..24]);
        let mut quote_id = [0u8; 32];
        quote_id.copy_from_slice(&data[64..96]);
        Ok(Self {
            tournament_id,
            player: read_pubkey(data, 24),
            amount: read_u64(data, 56),
            quote_id,
            price_micro_usd: read_u64(data, 96),
            status: data[104],
            bump: data[105],
            burn_key: data[106..138].try_into().unwrap(),
        })
    }
}

impl PrizeReserve {
    pub const LEN: usize = PRIZE_RESERVE_SPACE;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&PRIZE_RESERVE_DISCRIMINATOR);
        dst[8..24].copy_from_slice(&self.tournament_id);
        write_pubkey(dst, 24, &self.winner);
        write_u64(dst, 56, self.amount);
        dst[64] = self.status;
        dst[65] = self.winner_set as u8;
        dst[66] = self.bump;
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &PRIZE_RESERVE_DISCRIMINATOR)?;
        let mut tournament_id = [0u8; 16];
        tournament_id.copy_from_slice(&data[8..24]);
        Ok(Self {
            tournament_id,
            winner: read_pubkey(data, 24),
            amount: read_u64(data, 56),
            status: data[64],
            winner_set: data[65] != 0,
            bump: data[66],
        })
    }
}

impl CardsPrizeReserve {
    pub const LEN: usize = CARDS_PRIZE_RESERVE_SPACE;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&CARDS_PRIZE_RESERVE_DISCRIMINATOR);
        dst[8..24].copy_from_slice(&self.tournament_id);
        write_pubkey(dst, 24, &self.funder);
        write_pubkey(dst, 56, &self.winner);
        write_u64(dst, 88, self.cards_amount);
        dst[96] = self.status;
        dst[97] = self.winner_set as u8;
        dst[98] = self.bump;
        dst[99..131].copy_from_slice(&self.fund_key);
        dst[131..163].copy_from_slice(&self.pay_key);
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &CARDS_PRIZE_RESERVE_DISCRIMINATOR)?;
        let mut tournament_id = [0u8; 16];
        tournament_id.copy_from_slice(&data[8..24]);
        Ok(Self {
            tournament_id,
            funder: read_pubkey(data, 24),
            winner: read_pubkey(data, 56),
            cards_amount: read_u64(data, 88),
            status: data[96],
            winner_set: data[97] != 0,
            bump: data[98],
            fund_key: data[99..131].try_into().unwrap(),
            pay_key: data[131..163].try_into().unwrap(),
        })
    }
}

impl Replay {
    pub const LEN: usize = REPLAY_SPACE;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&REPLAY_DISCRIMINATOR);
        dst[8..40].copy_from_slice(&self.key);
        dst[40] = self.kind;
        dst[41] = self.bump;
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &REPLAY_DISCRIMINATOR)?;
        let mut key = [0u8; 32];
        key.copy_from_slice(&data[8..40]);
        Ok(Self {
            key,
            kind: data[40],
            bump: data[41],
        })
    }
}

impl TreasuryDeposit {
    pub const LEN: usize = TREASURY_DEPOSIT_SPACE;

    pub fn pack(&self, dst: &mut [u8]) -> Result<(), ProgramError> {
        if dst.len() < Self::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        dst[0..8].copy_from_slice(&TREASURY_DEPOSIT_DISCRIMINATOR);
        dst[8..40].copy_from_slice(&self.claim_key);
        write_u64(dst, 40, self.gross_lamports);
        write_u64(dst, 48, self.treasury_lamports);
        write_u64(dst, 56, self.operator_lamports);
        dst[64] = self.bump;
        Ok(())
    }

    pub fn unpack(data: &[u8]) -> Result<Self, ProgramError> {
        if data.len() < Self::LEN {
            return Err(ProgramError::InvalidAccountData);
        }
        require_disc(data, &TREASURY_DEPOSIT_DISCRIMINATOR)?;
        let mut claim_key = [0u8; 32];
        claim_key.copy_from_slice(&data[8..40]);
        Ok(Self {
            claim_key,
            gross_lamports: read_u64(data, 40),
            treasury_lamports: read_u64(data, 48),
            operator_lamports: read_u64(data, 56),
            bump: data[64],
        })
    }
}

#[inline(always)]
pub fn require(cond: bool, err: ArenaError) -> Result<(), ProgramError> {
    if cond {
        Ok(())
    } else {
        Err(err.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_config(cards_mint: Pubkey) -> Config {
        Config {
            authority: [1u8; 32],
            fee_vault: [2u8; 32],
            treasury_vault: [3u8; 32],
            operator_vault: [4u8; 32],
            poke_mint: [5u8; 32],
            quote_authority: [6u8; 32],
            keeper: [7u8; 32],
            fee_bps: 200,
            treasury_bps: 9000,
            operator_bps: 1000,
            buyback_bps: 0,
            min_buyback_lamports: 50_000_000,
            bump: 254,
            cards_mint,
        }
    }

    #[test]
    fn config_is_305_bytes_and_cards_mint_is_at_offset_273() {
        assert_eq!(CONFIG_SPACE, 305);
        assert_eq!(CONFIG_PREFIX_SPACE, 273);
        let mut first = [0u8; CONFIG_SPACE];
        let mut second = [0u8; CONFIG_SPACE];
        sample_config(Pubkey::default()).pack(&mut first).unwrap();
        sample_config([9u8; 32]).pack(&mut second).unwrap();
        assert_eq!(&first[..273], &second[..273]);
        assert_eq!(&first[273..305], &[0u8; 32]);
        assert_eq!(&second[273..305], &[9u8; 32]);
        assert_eq!(first[272], 254);
        assert_eq!(first[136..168], [5u8; 32]);
        let decoded = Config::unpack(&second).unwrap();
        assert_eq!(decoded.cards_mint, [9u8; 32]);
        assert_eq!(decoded.poke_mint, [5u8; 32]);
        assert_eq!(decoded.fee_bps, 200);
        assert!(Config::unpack(&first[..273]).is_err());
    }

    #[test]
    fn cards_prize_reserve_layout_matches_the_client_decoder() {
        assert_eq!(CARDS_PRIZE_RESERVE_SPACE, 163);
        assert_eq!(
            CARDS_PRIZE_RESERVE_DISCRIMINATOR,
            [0xb5, 0x15, 0x86, 0x05, 0x7d, 0x1d, 0x88, 0xb1]
        );
        let reserve = CardsPrizeReserve {
            tournament_id: [4u8; 16],
            funder: [8u8; 32],
            winner: [7u8; 32],
            cards_amount: 100,
            status: PrizeStatus::Reserved as u8,
            winner_set: false,
            bump: 3,
            fund_key: [6u8; 32],
            pay_key: [0u8; 32],
        };
        let mut data = [0u8; CARDS_PRIZE_RESERVE_SPACE];
        reserve.pack(&mut data).unwrap();
        assert_eq!(&data[8..24], &[4u8; 16]);
        assert_eq!(&data[24..56], &[8u8; 32]);
        assert_eq!(&data[56..88], &[7u8; 32]);
        assert_eq!(u64::from_le_bytes(data[88..96].try_into().unwrap()), 100);
        assert_eq!(data[96], 0);
        assert_eq!(data[97], 0);
        assert_eq!(data[98], 3);
        assert_eq!(&data[99..131], &[6u8; 32]);
        assert_eq!(&data[131..163], &[0u8; 32]);
        let decoded = CardsPrizeReserve::unpack(&data).unwrap();
        assert_eq!(decoded.cards_amount, 100);
        assert_eq!(decoded.fund_key, [6u8; 32]);
        assert_eq!(decoded.pay_key, [0u8; 32]);
        assert!(!decoded.winner_set);
    }

    #[test]
    fn replay_kinds_match_the_staging_pinocchio_source() {
        assert_eq!(ReplayKind::CardsPrizeFund as u8, 6);
        assert_eq!(ReplayKind::CardsPrizePay as u8, 7);
        assert_eq!(ReplayKind::FeeVaultClaim as u8, 8);
        assert_eq!(ReplayKind::CardsOperatorClaim as u8, 9);
        assert_eq!(ReplayKind::CardsTreasuryFund as u8, 10);
        assert_eq!(MATCH_ESCROW_SPACE, 133);
        assert_eq!(ENTRY_ESCROW_SPACE, 138);
        assert_eq!(TOURNAMENT_ENTRY_ATOMS, 10_000_000_000);
    }
}
