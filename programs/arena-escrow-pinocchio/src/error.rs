use pinocchio::program_error::ProgramError;

/// Anchor `#[error_code]` offset starts at 6000.
#[repr(u32)]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArenaError {
    InvalidAmount = 0,
    InvalidBps = 1,
    Unauthorized = 2,
    AlreadyDeposited = 3,
    NotDeposited = 4,
    InvalidSide = 5,
    InvalidMatchStatus = 6,
    FeeAlreadyCharged = 7,
    FeeNotCharged = 8,
    InvalidEntryStatus = 9,
    InvalidPrizeStatus = 10,
    PrizeWinnerAlreadySet = 11,
    PrizeWinnerNotSet = 12,
    Overflow = 13,
    BuybackTooSmall = 14,
    InsufficientFunds = 15,
    SlippageExceeded = 16,
    PokeMintNotConfigured = 17,
    PokeMintAlreadySet = 18,
    InvalidMint = 19,
    CardsMintNotConfigured = 20,
    CardsMintAlreadySet = 21,
    /// Lamports above rent, or a non-zero token amount, still sit in the account.
    BalanceRemaining = 22,
}

impl From<ArenaError> for ProgramError {
    #[inline(always)]
    fn from(e: ArenaError) -> Self {
        ProgramError::Custom(6000 + e as u32)
    }
}
