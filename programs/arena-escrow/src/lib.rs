use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount, Transfer};
use anchor_spl::token::{self, Burn, Mint, Token, TokenAccount, Transfer as TokenTransfer};

declare_id!("41GGgA4QzQfWxqUmqkitkhhcyrfMuVxq7Gr2FDwdbu4W");

pub const CASUAL_FEE_BPS: u64 = 200;
pub const TREASURY_BPS: u64 = 9000;
pub const OPERATOR_BPS: u64 = 1000;
pub const BPS_DENOM: u64 = 10_000;
pub const POKE_MINT_DECIMALS: u8 = 6;

fn mint_for_init(account: &AccountInfo) -> Result<Pubkey> {
    if *account.key == system_program::ID {
        return Ok(Pubkey::default());
    }
    validated_poke_mint(account)
}

fn validated_poke_mint(account: &AccountInfo) -> Result<Pubkey> {
    if *account.key == system_program::ID || *account.key == Pubkey::default() {
        return err!(ArenaError::InvalidMint);
    }
    require!(*account.owner == token::ID, ArenaError::InvalidMint);
    let data = account.try_borrow_data().map_err(|_| error!(ArenaError::InvalidMint))?;
    require!(data.len() >= 82, ArenaError::InvalidMint);
    require!(data[44] == POKE_MINT_DECIMALS, ArenaError::InvalidMint);
    Ok(*account.key)
}

#[program]
pub mod arena_escrow {
    use super::*;

    pub fn initialize_config(
        ctx: Context<InitializeConfig>,
        buyback_bps: u64,
        min_buyback_lamports: u64,
    ) -> Result<()> {
        require!(buyback_bps <= BPS_DENOM, ArenaError::InvalidBps);
        let cfg = &mut ctx.accounts.config;
        cfg.authority = ctx.accounts.authority.key();
        cfg.fee_vault = ctx.accounts.fee_vault.key();
        cfg.treasury_vault = ctx.accounts.treasury_vault.key();
        cfg.operator_vault = ctx.accounts.operator_vault.key();
        cfg.poke_mint = ctx.accounts.poke_mint.key();
        cfg.quote_authority = ctx.accounts.quote_authority.key();
        cfg.keeper = ctx.accounts.keeper.key();
        cfg.fee_bps = CASUAL_FEE_BPS;
        cfg.treasury_bps = TREASURY_BPS;
        cfg.operator_bps = OPERATOR_BPS;
        cfg.buyback_bps = buyback_bps;
        cfg.min_buyback_lamports = min_buyback_lamports;
        cfg.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_match_escrow(
        ctx: Context<CreateMatchEscrow>,
        room_id: [u8; 16],
        collateral_lamports: u64,
    ) -> Result<()> {
        require!(collateral_lamports > 0, ArenaError::InvalidAmount);
        let escrow = &mut ctx.accounts.match_escrow;
        escrow.room_id = room_id;
        escrow.creator = ctx.accounts.creator.key();
        escrow.opponent = Pubkey::default();
        escrow.collateral_lamports = collateral_lamports;
        escrow.creator_deposited = false;
        escrow.opponent_deposited = false;
        escrow.fee_charged = false;
        escrow.status = MatchStatus::Open as u8;
        escrow.bump = ctx.bumps.match_escrow;

        // Create the SOL vault PDA as a system-owned account (space 0).
        let vault_bump = ctx.bumps.match_vault;
        let rent = Rent::get()?.minimum_balance(0);
        let seeds: &[&[u8]] = &[b"match_vault", room_id.as_ref(), &[vault_bump]];
        system_program::create_account(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                CreateAccount {
                    from: ctx.accounts.creator.to_account_info(),
                    to: ctx.accounts.match_vault.to_account_info(),
                },
                &[seeds],
            ),
            rent,
            0,
            ctx.program_id,
        )?;
        Ok(())
    }

    pub fn deposit_sol_wager(ctx: Context<DepositSolWager>, side: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            escrow.status == MatchStatus::Open as u8 || escrow.status == MatchStatus::Funding as u8,
            ArenaError::InvalidMatchStatus
        );
        let amount = escrow.collateral_lamports;
        let depositor = ctx.accounts.depositor.key();

        match side {
            0 => {
                require!(depositor == escrow.creator, ArenaError::Unauthorized);
                require!(!escrow.creator_deposited, ArenaError::AlreadyDeposited);
                escrow.creator_deposited = true;
            }
            1 => {
                // Opponent is seated by the keeper before this deposit. The first
                // wallet to arrive must not be able to claim the seat.
                require!(escrow.opponent != Pubkey::default(), ArenaError::Unauthorized);
                require!(depositor == escrow.opponent, ArenaError::Unauthorized);
                require!(!escrow.opponent_deposited, ArenaError::AlreadyDeposited);
                escrow.opponent_deposited = true;
            }
            _ => return err!(ArenaError::InvalidSide),
        }

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor.to_account_info(),
                    to: ctx.accounts.match_vault.to_account_info(),
                },
            ),
            amount,
        )?;

        escrow.status = if escrow.creator_deposited && escrow.opponent_deposited {
            MatchStatus::Funded as u8
        } else {
            MatchStatus::Funding as u8
        };
        Ok(())
    }

    pub fn seat_match_opponent(ctx: Context<SeatMatchOpponent>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );
        require!(
            escrow.status == MatchStatus::Open as u8 || escrow.status == MatchStatus::Funding as u8,
            ArenaError::InvalidMatchStatus
        );
        require!(!escrow.opponent_deposited, ArenaError::AlreadyDeposited);
        let opponent = ctx.accounts.opponent.key();
        require!(opponent != Pubkey::default(), ArenaError::Unauthorized);
        require!(opponent != escrow.creator, ArenaError::Unauthorized);
        if escrow.opponent != Pubkey::default() {
            require!(escrow.opponent == opponent, ArenaError::Unauthorized);
            return Ok(());
        }
        escrow.opponent = opponent;
        Ok(())
    }

    pub fn refund_sol_wager(ctx: Context<RefundSolWager>, side: u8) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );
        require!(
            escrow.status == MatchStatus::Open as u8
                || escrow.status == MatchStatus::Funding as u8
                || escrow.status == MatchStatus::Cancelled as u8,
            ArenaError::InvalidMatchStatus
        );
        require!(!escrow.fee_charged, ArenaError::FeeAlreadyCharged);

        let amount = escrow.collateral_lamports;
        let recipient = match side {
            0 => {
                require!(escrow.creator_deposited, ArenaError::NotDeposited);
                escrow.creator
            }
            1 => {
                require!(escrow.opponent_deposited, ArenaError::NotDeposited);
                escrow.opponent
            }
            _ => return err!(ArenaError::InvalidSide),
        };
        require!(ctx.accounts.recipient.key() == recipient, ArenaError::Unauthorized);

        **ctx
            .accounts
            .match_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .recipient
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;

        match side {
            0 => escrow.creator_deposited = false,
            1 => escrow.opponent_deposited = false,
            _ => {}
        }
        escrow.status = MatchStatus::Cancelled as u8;
        Ok(())
    }

    pub fn charge_match_fee(ctx: Context<ChargeMatchFee>) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(escrow.status == MatchStatus::Funded as u8, ArenaError::InvalidMatchStatus);
        require!(!escrow.fee_charged, ArenaError::FeeAlreadyCharged);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let total = escrow
            .collateral_lamports
            .checked_mul(2)
            .ok_or(ArenaError::Overflow)?;
        let fee = total
            .checked_mul(ctx.accounts.config.fee_bps)
            .ok_or(ArenaError::Overflow)?
            / BPS_DENOM;

        **ctx
            .accounts
            .match_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= fee;
        **ctx
            .accounts
            .fee_vault
            .to_account_info()
            .try_borrow_mut_lamports()? += fee;

        escrow.fee_charged = true;
        escrow.status = MatchStatus::Active as u8;
        Ok(())
    }

    pub fn settle_match_win(ctx: Context<SettleMatchWin>, settlement_key: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        require!(escrow.status == MatchStatus::Active as u8, ArenaError::InvalidMatchStatus);
        require!(escrow.fee_charged, ArenaError::FeeNotCharged);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let winner = ctx.accounts.winner.key();
        require!(
            winner == escrow.creator || winner == escrow.opponent,
            ArenaError::Unauthorized
        );

        let replay = &mut ctx.accounts.replay;
        replay.key = settlement_key;
        replay.kind = ReplayKind::MatchWin as u8;
        replay.bump = ctx.bumps.replay;

        let vault_lamports = ctx.accounts.match_vault.lamports();
        let rent = Rent::get()?.minimum_balance(0);
        let payout = vault_lamports.saturating_sub(rent);
        **ctx
            .accounts
            .match_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= payout;
        **ctx
            .accounts
            .winner
            .to_account_info()
            .try_borrow_mut_lamports()? += payout;

        escrow.status = MatchStatus::Settled as u8;
        Ok(())
    }

    pub fn settle_match_tie(ctx: Context<SettleMatchTie>, settlement_key: [u8; 32]) -> Result<()> {
        let escrow = &mut ctx.accounts.match_escrow;
        // Pre-start cancel/tie: Funded without fee. Post-start tie: Active after fee
        // was charged; remaining vault (after fee) is split evenly.
        require!(
            escrow.status == MatchStatus::Funded as u8 || escrow.status == MatchStatus::Active as u8,
            ArenaError::InvalidMatchStatus
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let replay = &mut ctx.accounts.replay;
        replay.key = settlement_key;
        replay.kind = ReplayKind::MatchTie as u8;
        replay.bump = ctx.bumps.replay;

        let vault_lamports = ctx.accounts.match_vault.lamports();
        let rent = Rent::get()?.minimum_balance(0);
        let payout = vault_lamports.saturating_sub(rent);
        let each = payout / 2;
        let rem = payout - each * 2;
        **ctx
            .accounts
            .match_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= payout;
        **ctx
            .accounts
            .creator
            .to_account_info()
            .try_borrow_mut_lamports()? += each;
        **ctx
            .accounts
            .opponent
            .to_account_info()
            .try_borrow_mut_lamports()? += each + rem;

        escrow.status = MatchStatus::Settled as u8;
        Ok(())
    }

    pub fn deposit_poke_entry(
        ctx: Context<DepositPokeEntry>,
        tournament_id: [u8; 16],
        amount: u64,
        quote_id: [u8; 32],
        price_micro_usd: u64,
    ) -> Result<()> {
        require!(amount > 0, ArenaError::InvalidAmount);
        require!(
            ctx.accounts.config.poke_mint != Pubkey::default(),
            ArenaError::PokeMintNotConfigured
        );
        let entry = &mut ctx.accounts.entry_escrow;
        entry.tournament_id = tournament_id;
        entry.player = ctx.accounts.player.key();
        entry.amount = amount;
        entry.quote_id = quote_id;
        entry.price_micro_usd = price_micro_usd;
        entry.status = EntryStatus::Reserved as u8;
        entry.bump = ctx.bumps.entry_escrow;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.player_poke.to_account_info(),
                    to: ctx.accounts.entry_vault.to_account_info(),
                    authority: ctx.accounts.player.to_account_info(),
                },
            ),
            amount,
        )?;
        Ok(())
    }

    pub fn refund_poke_entry(ctx: Context<RefundPokeEntry>) -> Result<()> {
        require!(
            ctx.accounts.config.poke_mint != Pubkey::default(),
            ArenaError::PokeMintNotConfigured
        );
        require!(
            ctx.accounts.entry_escrow.status == EntryStatus::Reserved as u8,
            ArenaError::InvalidEntryStatus
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper
                || ctx.accounts.authority.key() == ctx.accounts.entry_escrow.player,
            ArenaError::Unauthorized
        );

        let amount = ctx.accounts.entry_escrow.amount;
        let tournament_id = ctx.accounts.entry_escrow.tournament_id;
        let player = ctx.accounts.entry_escrow.player;
        let bump = ctx.accounts.entry_escrow.bump;
        let seeds: &[&[u8]] = &[
            b"entry_escrow",
            tournament_id.as_ref(),
            player.as_ref(),
            &[bump],
        ];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TokenTransfer {
                    from: ctx.accounts.entry_vault.to_account_info(),
                    to: ctx.accounts.player_poke.to_account_info(),
                    authority: ctx.accounts.entry_escrow.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        ctx.accounts.entry_escrow.status = EntryStatus::Refunded as u8;
        Ok(())
    }

    pub fn burn_poke_entry(ctx: Context<BurnPokeEntry>, burn_key: [u8; 32]) -> Result<()> {
        require!(
            ctx.accounts.config.poke_mint != Pubkey::default(),
            ArenaError::PokeMintNotConfigured
        );
        require!(
            ctx.accounts.entry_escrow.status == EntryStatus::Reserved as u8,
            ArenaError::InvalidEntryStatus
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        ctx.accounts.replay.key = burn_key;
        ctx.accounts.replay.kind = ReplayKind::EntryBurn as u8;
        ctx.accounts.replay.bump = ctx.bumps.replay;

        let amount = ctx.accounts.entry_escrow.amount;
        let tournament_id = ctx.accounts.entry_escrow.tournament_id;
        let player = ctx.accounts.entry_escrow.player;
        let bump = ctx.accounts.entry_escrow.bump;
        let seeds: &[&[u8]] = &[
            b"entry_escrow",
            tournament_id.as_ref(),
            player.as_ref(),
            &[bump],
        ];

        token::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.poke_mint.to_account_info(),
                    from: ctx.accounts.entry_vault.to_account_info(),
                    authority: ctx.accounts.entry_escrow.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        ctx.accounts.entry_escrow.status = EntryStatus::Burned as u8;
        Ok(())
    }

    pub fn deposit_treasury_sol(
        ctx: Context<DepositTreasurySol>,
        claim_key: [u8; 32],
        gross_lamports: u64,
    ) -> Result<()> {
        require!(gross_lamports > 0, ArenaError::InvalidAmount);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let treasury_share = gross_lamports
            .checked_mul(ctx.accounts.config.treasury_bps)
            .ok_or(ArenaError::Overflow)?
            / BPS_DENOM;
        let operator_share = gross_lamports
            .checked_sub(treasury_share)
            .ok_or(ArenaError::Overflow)?;

        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.treasury_vault.to_account_info(),
                },
            ),
            treasury_share,
        )?;
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer.to_account_info(),
                    to: ctx.accounts.operator_vault.to_account_info(),
                },
            ),
            operator_share,
        )?;

        let replay = &mut ctx.accounts.replay;
        replay.key = claim_key;
        replay.kind = ReplayKind::TreasuryDeposit as u8;
        replay.bump = ctx.bumps.replay;

        let ledger = &mut ctx.accounts.treasury_deposit;
        ledger.claim_key = claim_key;
        ledger.gross_lamports = gross_lamports;
        ledger.treasury_lamports = treasury_share;
        ledger.operator_lamports = operator_share;
        ledger.bump = ctx.bumps.treasury_deposit;
        Ok(())
    }

    pub fn reserve_prize(
        ctx: Context<ReservePrize>,
        tournament_id: [u8; 16],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ArenaError::InvalidAmount);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let reserve = &mut ctx.accounts.prize_reserve;
        reserve.tournament_id = tournament_id;
        reserve.amount = amount;
        reserve.status = PrizeStatus::Reserved as u8;
        reserve.winner = Pubkey::default();
        reserve.winner_set = false;
        reserve.bump = ctx.bumps.prize_reserve;

        // Ensure prize vault PDA exists (system-owned, space 0).
        if ctx.accounts.prize_vault.lamports() == 0 && ctx.accounts.prize_vault.data_is_empty() {
            let vault_bump = ctx.bumps.prize_vault;
            let rent = Rent::get()?.minimum_balance(0);
            let seeds: &[&[u8]] = &[b"prize_vault", tournament_id.as_ref(), &[vault_bump]];
            system_program::create_account(
                CpiContext::new_with_signer(
                    ctx.accounts.system_program.to_account_info(),
                    CreateAccount {
                        from: ctx.accounts.authority.to_account_info(),
                        to: ctx.accounts.prize_vault.to_account_info(),
                    },
                    &[seeds],
                ),
                rent,
                0,
                ctx.program_id,
            )?;
        }

        **ctx
            .accounts
            .treasury_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .prize_vault
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        Ok(())
    }

    pub fn set_prize_winner(ctx: Context<SetPrizeWinner>) -> Result<()> {
        let reserve = &mut ctx.accounts.prize_reserve;
        require!(reserve.status == PrizeStatus::Reserved as u8, ArenaError::InvalidPrizeStatus);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );
        require!(!reserve.winner_set, ArenaError::PrizeWinnerAlreadySet);
        reserve.winner = ctx.accounts.winner.key();
        reserve.winner_set = true;
        Ok(())
    }

    pub fn pay_prize(ctx: Context<PayPrize>, settlement_key: [u8; 32]) -> Result<()> {
        let reserve = &mut ctx.accounts.prize_reserve;
        require!(reserve.status == PrizeStatus::Reserved as u8, ArenaError::InvalidPrizeStatus);
        require!(reserve.winner_set, ArenaError::PrizeWinnerNotSet);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let replay = &mut ctx.accounts.replay;
        replay.key = settlement_key;
        replay.kind = ReplayKind::PrizePay as u8;
        replay.bump = ctx.bumps.replay;

        let amount = reserve.amount;
        **ctx
            .accounts
            .prize_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .winner
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        reserve.status = PrizeStatus::Paid as u8;
        Ok(())
    }

    pub fn release_prize(ctx: Context<ReleasePrize>) -> Result<()> {
        let reserve = &mut ctx.accounts.prize_reserve;
        require!(reserve.status == PrizeStatus::Reserved as u8, ArenaError::InvalidPrizeStatus);
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let amount = reserve.amount;
        **ctx
            .accounts
            .prize_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= amount;
        **ctx
            .accounts
            .treasury_vault
            .to_account_info()
            .try_borrow_mut_lamports()? += amount;
        reserve.status = PrizeStatus::Released as u8;
        Ok(())
    }

    pub fn buyback_and_burn_poke(
        ctx: Context<BuybackAndBurnPoke>,
        buyback_key: [u8; 32],
        sol_amount: u64,
        min_poke_out: u64,
    ) -> Result<()> {
        require!(
            ctx.accounts.config.poke_mint != Pubkey::default(),
            ArenaError::PokeMintNotConfigured
        );
        require!(sol_amount > 0, ArenaError::InvalidAmount);
        require!(
            sol_amount >= ctx.accounts.config.min_buyback_lamports,
            ArenaError::BuybackTooSmall
        );
        require!(
            ctx.accounts.authority.key() == ctx.accounts.config.authority
                || ctx.accounts.authority.key() == ctx.accounts.config.keeper,
            ArenaError::Unauthorized
        );

        let max_sol = ctx
            .accounts
            .fee_vault
            .lamports()
            .saturating_sub(Rent::get()?.minimum_balance(0));
        let spend = sol_amount
            .checked_mul(ctx.accounts.config.buyback_bps)
            .ok_or(ArenaError::Overflow)?
            / BPS_DENOM;
        require!(spend > 0 && spend <= max_sol, ArenaError::InsufficientFunds);

        let replay = &mut ctx.accounts.replay;
        replay.key = buyback_key;
        replay.kind = ReplayKind::BuybackBurn as u8;
        replay.bump = ctx.bumps.replay;

        // Keeper supplies POKE into burn ATA after off-chain swap; program burns min_poke_out.
        // SOL moves from fee vault to keeper swap wallet (documented off-chain swap step).
        **ctx
            .accounts
            .fee_vault
            .to_account_info()
            .try_borrow_mut_lamports()? -= spend;
        **ctx
            .accounts
            .swap_wallet
            .to_account_info()
            .try_borrow_mut_lamports()? += spend;

        require!(
            ctx.accounts.poke_burn_source.amount >= min_poke_out,
            ArenaError::SlippageExceeded
        );
        token::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.poke_mint.to_account_info(),
                    from: ctx.accounts.poke_burn_source.to_account_info(),
                    authority: ctx.accounts.authority.to_account_info(),
                },
            ),
            min_poke_out,
        )?;
        Ok(())
    }

    pub fn set_poke_mint(ctx: Context<SetPokeMint>) -> Result<()> {
        let cfg = &mut ctx.accounts.config;
        require!(
            ctx.accounts.authority.key() == cfg.authority,
            ArenaError::Unauthorized
        );
        require!(
            cfg.poke_mint == Pubkey::default(),
            ArenaError::PokeMintAlreadySet
        );
        cfg.poke_mint = validated_poke_mint(&ctx.accounts.poke_mint.to_account_info())?;
        Ok(())
    }
}

#[account]
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
}

#[account]
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
}

#[account]
pub struct EntryEscrow {
    pub tournament_id: [u8; 16],
    pub player: Pubkey,
    pub amount: u64,
    pub quote_id: [u8; 32],
    pub price_micro_usd: u64,
    pub status: u8,
    pub bump: u8,
}

#[account]
pub struct PrizeReserve {
    pub tournament_id: [u8; 16],
    pub winner: Pubkey,
    pub amount: u64,
    pub status: u8,
    pub winner_set: bool,
    pub bump: u8,
}

#[account]
pub struct Replay {
    pub key: [u8; 32],
    pub kind: u8,
    pub bump: u8,
}

#[account]
pub struct TreasuryDeposit {
    pub claim_key: [u8; 32],
    pub gross_lamports: u64,
    pub treasury_lamports: u64,
    pub operator_lamports: u64,
    pub bump: u8,
}

#[repr(u8)]
pub enum MatchStatus {
    Open = 0,
    Funding = 1,
    Funded = 2,
    Active = 3,
    Settled = 4,
    Cancelled = 5,
}

#[repr(u8)]
pub enum EntryStatus {
    Reserved = 0,
    Burned = 1,
    Refunded = 2,
}

#[repr(u8)]
pub enum PrizeStatus {
    Reserved = 0,
    Paid = 1,
    Released = 2,
}

#[repr(u8)]
pub enum ReplayKind {
    MatchWin = 0,
    MatchTie = 1,
    EntryBurn = 2,
    TreasuryDeposit = 3,
    PrizePay = 4,
    BuybackBurn = 5,
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: program-owned fee vault PDA (lamports only)
    #[account(
        init,
        payer = authority,
        space = 8,
        seeds = [b"fee_vault"],
        bump
    )]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: program-owned treasury vault PDA
    #[account(
        init,
        payer = authority,
        space = 8,
        seeds = [b"treasury_vault"],
        bump
    )]
    pub treasury_vault: UncheckedAccount<'info>,
    /// CHECK: program-owned operator vault PDA
    #[account(
        init,
        payer = authority,
        space = 8,
        seeds = [b"operator_vault"],
        bump
    )]
    pub operator_vault: UncheckedAccount<'info>,
    /// CHECK: System Program stores an unset mint. Any other account must be a 6-decimal Tokenkeg mint.
    pub poke_mint: UncheckedAccount<'info>,
    /// CHECK: quote authority pubkey stored only
    pub quote_authority: UncheckedAccount<'info>,
    /// CHECK: keeper pubkey stored only
    pub keeper: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 * 7 + 8 * 5 + 1,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPokeMint<'info> {
    pub authority: Signer<'info>,
    #[account(mut)]
    pub config: Account<'info, Config>,
    /// CHECK: classic SPL mint, 6 decimals, rejected when config.poke_mint is already set
    pub poke_mint: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(room_id: [u8; 16])]
pub struct CreateMatchEscrow<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = creator,
        space = 8 + 16 + 32 * 2 + 8 + 1 * 4 + 1 + 1,
        seeds = [b"match_escrow", room_id.as_ref()],
        bump
    )]
    pub match_escrow: Account<'info, MatchEscrow>,
    /// CHECK: SOL vault for the match
    #[account(
        mut,
        seeds = [b"match_vault", room_id.as_ref()],
        bump
    )]
    pub match_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositSolWager<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [b"match_escrow", match_escrow.room_id.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    /// CHECK: match vault
    #[account(mut, seeds = [b"match_vault", match_escrow.room_id.as_ref()], bump)]
    pub match_vault: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SeatMatchOpponent<'info> {
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    /// CHECK: wallet the keeper has seated; it does not sign this instruction
    pub opponent: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"match_escrow", match_escrow.room_id.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
}

#[derive(Accounts)]
pub struct RefundSolWager<'info> {
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub recipient: SystemAccount<'info>,
    #[account(mut, seeds = [b"match_escrow", match_escrow.room_id.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    /// CHECK: match vault
    #[account(mut, seeds = [b"match_vault", match_escrow.room_id.as_ref()], bump)]
    pub match_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct ChargeMatchFee<'info> {
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"match_escrow", match_escrow.room_id.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    /// CHECK: match vault
    #[account(mut, seeds = [b"match_vault", match_escrow.room_id.as_ref()], bump)]
    pub match_vault: UncheckedAccount<'info>,
    /// CHECK: fee vault
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(settlement_key: [u8; 32])]
pub struct SettleMatchWin<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(mut)]
    pub winner: SystemAccount<'info>,
    #[account(mut, seeds = [b"match_escrow", match_escrow.room_id.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    /// CHECK: match vault
    #[account(mut, seeds = [b"match_vault", match_escrow.room_id.as_ref()], bump)]
    pub match_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 1,
        seeds = [b"replay", settlement_key.as_ref()],
        bump
    )]
    pub replay: Account<'info, Replay>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(settlement_key: [u8; 32])]
pub struct SettleMatchTie<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"match_escrow", match_escrow.room_id.as_ref()], bump = match_escrow.bump)]
    pub match_escrow: Account<'info, MatchEscrow>,
    #[account(mut, address = match_escrow.creator)]
    pub creator: SystemAccount<'info>,
    #[account(mut, address = match_escrow.opponent)]
    pub opponent: SystemAccount<'info>,
    /// CHECK: match vault
    #[account(mut, seeds = [b"match_vault", match_escrow.room_id.as_ref()], bump)]
    pub match_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 1,
        seeds = [b"replay", settlement_key.as_ref()],
        bump
    )]
    pub replay: Account<'info, Replay>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tournament_id: [u8; 16])]
pub struct DepositPokeEntry<'info> {
    #[account(mut)]
    pub player: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(address = config.poke_mint)]
    pub poke_mint: Account<'info, Mint>,
    #[account(mut, token::mint = poke_mint, token::authority = player)]
    pub player_poke: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = player,
        space = 8 + 16 + 32 + 8 + 32 + 8 + 1 + 1,
        seeds = [b"entry_escrow", tournament_id.as_ref(), player.key().as_ref()],
        bump
    )]
    pub entry_escrow: Account<'info, EntryEscrow>,
    #[account(
        init,
        payer = player,
        token::mint = poke_mint,
        token::authority = entry_escrow,
        seeds = [b"entry_vault", tournament_id.as_ref(), player.key().as_ref()],
        bump
    )]
    pub entry_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct RefundPokeEntry<'info> {
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(address = config.poke_mint)]
    pub poke_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"entry_escrow", entry_escrow.tournament_id.as_ref(), entry_escrow.player.as_ref()],
        bump = entry_escrow.bump
    )]
    pub entry_escrow: Account<'info, EntryEscrow>,
    #[account(
        mut,
        token::mint = poke_mint,
        constraint = player_poke.owner == entry_escrow.player @ ArenaError::Unauthorized
    )]
    pub player_poke: Account<'info, TokenAccount>,
    #[account(
        mut,
        seeds = [b"entry_vault", entry_escrow.tournament_id.as_ref(), entry_escrow.player.as_ref()],
        bump
    )]
    pub entry_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(burn_key: [u8; 32])]
pub struct BurnPokeEntry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(mut, address = config.poke_mint)]
    pub poke_mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"entry_escrow", entry_escrow.tournament_id.as_ref(), entry_escrow.player.as_ref()],
        bump = entry_escrow.bump
    )]
    pub entry_escrow: Account<'info, EntryEscrow>,
    #[account(
        mut,
        token::mint = poke_mint,
        token::authority = entry_escrow,
        seeds = [b"entry_vault", entry_escrow.tournament_id.as_ref(), entry_escrow.player.as_ref()],
        bump
    )]
    pub entry_vault: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 1,
        seeds = [b"replay", burn_key.as_ref()],
        bump
    )]
    pub replay: Account<'info, Replay>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(claim_key: [u8; 32])]
pub struct DepositTreasurySol<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub config: Account<'info, Config>,
    /// CHECK: treasury
    #[account(mut, address = config.treasury_vault)]
    pub treasury_vault: UncheckedAccount<'info>,
    /// CHECK: operator
    #[account(mut, address = config.operator_vault)]
    pub operator_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 8 * 3 + 1,
        seeds = [b"treasury_deposit", claim_key.as_ref()],
        bump
    )]
    pub treasury_deposit: Account<'info, TreasuryDeposit>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 1,
        seeds = [b"replay", claim_key.as_ref()],
        bump
    )]
    pub replay: Account<'info, Replay>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(tournament_id: [u8; 16])]
pub struct ReservePrize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    /// CHECK: treasury
    #[account(mut, address = config.treasury_vault)]
    pub treasury_vault: UncheckedAccount<'info>,
    /// CHECK: prize vault PDA
    #[account(mut, seeds = [b"prize_vault", tournament_id.as_ref()], bump)]
    pub prize_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 16 + 32 + 8 + 1 + 1 + 1,
        seeds = [b"prize_reserve", tournament_id.as_ref()],
        bump
    )]
    pub prize_reserve: Account<'info, PrizeReserve>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPrizeWinner<'info> {
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"prize_reserve", prize_reserve.tournament_id.as_ref()],
        bump = prize_reserve.bump
    )]
    pub prize_reserve: Account<'info, PrizeReserve>,
    pub winner: SystemAccount<'info>,
}

#[derive(Accounts)]
#[instruction(settlement_key: [u8; 32])]
pub struct PayPrize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"prize_reserve", prize_reserve.tournament_id.as_ref()],
        bump = prize_reserve.bump
    )]
    pub prize_reserve: Account<'info, PrizeReserve>,
    #[account(mut, address = prize_reserve.winner)]
    pub winner: SystemAccount<'info>,
    /// CHECK: prize vault
    #[account(mut, seeds = [b"prize_vault", prize_reserve.tournament_id.as_ref()], bump)]
    pub prize_vault: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 1,
        seeds = [b"replay", settlement_key.as_ref()],
        bump
    )]
    pub replay: Account<'info, Replay>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ReleasePrize<'info> {
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    /// CHECK: treasury
    #[account(mut, address = config.treasury_vault)]
    pub treasury_vault: UncheckedAccount<'info>,
    #[account(
        mut,
        seeds = [b"prize_reserve", prize_reserve.tournament_id.as_ref()],
        bump = prize_reserve.bump
    )]
    pub prize_reserve: Account<'info, PrizeReserve>,
    /// CHECK: prize vault
    #[account(mut, seeds = [b"prize_vault", prize_reserve.tournament_id.as_ref()], bump)]
    pub prize_vault: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(buyback_key: [u8; 32])]
pub struct BuybackAndBurnPoke<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub config: Account<'info, Config>,
    /// CHECK: fee vault
    #[account(mut, address = config.fee_vault)]
    pub fee_vault: UncheckedAccount<'info>,
    /// CHECK: swap wallet receiving SOL for off-chain/DEX swap
    #[account(mut)]
    pub swap_wallet: UncheckedAccount<'info>,
    #[account(mut, address = config.poke_mint)]
    pub poke_mint: Account<'info, Mint>,
    #[account(mut, token::mint = poke_mint, token::authority = authority)]
    pub poke_burn_source: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        space = 8 + 32 + 1 + 1,
        seeds = [b"replay", buyback_key.as_ref()],
        bump
    )]
    pub replay: Account<'info, Replay>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum ArenaError {
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Invalid basis points")]
    InvalidBps,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Already deposited")]
    AlreadyDeposited,
    #[msg("Not deposited")]
    NotDeposited,
    #[msg("Invalid side")]
    InvalidSide,
    #[msg("Invalid match status")]
    InvalidMatchStatus,
    #[msg("Fee already charged")]
    FeeAlreadyCharged,
    #[msg("Fee not charged")]
    FeeNotCharged,
    #[msg("Invalid entry status")]
    InvalidEntryStatus,
    #[msg("Invalid prize status")]
    InvalidPrizeStatus,
    #[msg("Prize winner is already set")]
    PrizeWinnerAlreadySet,
    #[msg("Prize winner is not set")]
    PrizeWinnerNotSet,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Buyback amount below minimum")]
    BuybackTooSmall,
    #[msg("Insufficient funds")]
    InsufficientFunds,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("POKE mint is not configured")]
    PokeMintNotConfigured,
    #[msg("POKE mint is already configured")]
    PokeMintAlreadySet,
    #[msg("POKE mint must be a 6-decimal classic SPL mint")]
    InvalidMint,
}
