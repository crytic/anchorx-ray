use anchor_lang::prelude::*;

declare_id!("6PLfEPyKqpNThbdTSCBVuUBAjUpZCoh3DzdTDeLsbGh4");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod xray_vault {
    use super::*;

    pub fn init_config(ctx: Context<InitConfig>, fee_bps: u16) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.treasury = ctx.accounts.treasury.key();
        config.fee_bps = fee_bps;
        config.vault_count = 0;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    pub fn create_vault(ctx: Context<CreateVault>, vault_id: u64, label: String) -> Result<()> {
        require!(label.len() <= Vault::MAX_LABEL, VaultError::LabelTooLong);
        let vault = &mut ctx.accounts.vault;
        vault.owner = ctx.accounts.owner.key();
        vault.config = ctx.accounts.config.key();
        vault.vault_id = vault_id;
        vault.label = label;
        vault.state = VaultState::Active;
        vault.total_deposits = 0;
        vault.delegate = None;
        vault.bump = ctx.bumps.vault;
        ctx.accounts.config.vault_count += 1;
        emit!(VaultCreated {
            vault: vault.key(),
            owner: vault.owner,
            vault_id,
        });
        Ok(())
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.vault.state == VaultState::Active,
            VaultError::VaultFrozen
        );
        let cpi_accounts = anchor_lang::system_program::Transfer {
            from: ctx.accounts.depositor.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(anchor_lang::system_program::ID, cpi_accounts);
        anchor_lang::system_program::transfer(cpi_ctx, amount)?;

        let receipt = &mut ctx.accounts.receipt;
        receipt.vault = ctx.accounts.vault.key();
        receipt.depositor = ctx.accounts.depositor.key();
        receipt.amount = amount;
        receipt.slot = Clock::get()?.slot;
        ctx.accounts.vault.total_deposits += amount;
        emit!(Deposited {
            vault: receipt.vault,
            depositor: receipt.depositor,
            amount,
        });
        Ok(())
    }

    pub fn set_delegate(ctx: Context<SetDelegate>, delegate: Option<Pubkey>) -> Result<()> {
        ctx.accounts.vault.delegate = delegate;
        Ok(())
    }

    pub fn set_state(ctx: Context<SetState>, state: VaultState) -> Result<()> {
        ctx.accounts.vault.state = state;
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(vault.state == VaultState::Active, VaultError::VaultFrozen);
        require!(amount <= vault.total_deposits, VaultError::InsufficientFunds);
        vault.total_deposits -= amount;
        vault.sub_lamports(amount)?;
        ctx.accounts.owner.add_lamports(amount)?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    /// CHECK: any account can receive fees.
    pub treasury: UncheckedAccount<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(vault_id: u64)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = owner,
        space = 8 + Vault::INIT_SPACE,
        seeds = [VAULT_SEED, owner.key().as_ref(), &vault_id.to_le_bytes()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(
        mut,
        seeds = [VAULT_SEED, vault.owner.as_ref(), &vault.vault_id.to_le_bytes()],
        bump = vault.bump
    )]
    pub vault: Account<'info, Vault>,
    #[account(init, payer = depositor, space = 8 + Receipt::INIT_SPACE)]
    pub receipt: Account<'info, Receipt>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetDelegate<'info> {
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct SetState<'info> {
    pub admin: Signer<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin)]
    pub config: Account<'info, Config>,
    #[account(mut, has_one = config)]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, has_one = owner)]
    pub vault: Account<'info, Vault>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub treasury: Pubkey,
    pub fee_bps: u16,
    pub vault_count: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub owner: Pubkey,
    pub config: Pubkey,
    pub vault_id: u64,
    #[max_len(32)]
    pub label: String,
    pub state: VaultState,
    pub total_deposits: u64,
    pub delegate: Option<Pubkey>,
    pub bump: u8,
}

impl Vault {
    pub const MAX_LABEL: usize = 32;
}

#[account]
#[derive(InitSpace)]
pub struct Receipt {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
    pub slot: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq, InitSpace)]
pub enum VaultState {
    Active,
    Frozen {
        #[max_len(32)]
        reason: String,
    },
}

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub owner: Pubkey,
    pub vault_id: u64,
}

#[event]
pub struct Deposited {
    pub vault: Pubkey,
    pub depositor: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum VaultError {
    #[msg("Vault label is longer than 32 bytes")]
    LabelTooLong,
    #[msg("Vault is frozen")]
    VaultFrozen,
    #[msg("Withdrawal exceeds recorded deposits")]
    InsufficientFunds,
}
