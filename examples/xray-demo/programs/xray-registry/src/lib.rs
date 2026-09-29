use anchor_lang::prelude::*;
use xray_vault::program::XrayVault;

declare_id!("DtkVbe7MzaPYfZ5cgmp1QaVWtd592LW5ffG5BVUp3sGx");

pub const REGISTRY_SEED: &[u8] = b"registry";
pub const ENTRY_SEED: &[u8] = b"entry";
pub const MAX_ENTRIES: usize = 8;

#[program]
pub mod xray_registry {
    use super::*;

    pub fn init_registry(ctx: Context<InitRegistry>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        registry.authority = ctx.accounts.authority.key();
        registry.entries = Vec::new();
        registry.bump = ctx.bumps.registry;
        Ok(())
    }

    pub fn register(ctx: Context<Register>, name: String, tags: Vec<String>) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        require!(registry.entries.len() < MAX_ENTRIES, RegistryError::RegistryFull);
        let entry = &mut ctx.accounts.entry;
        entry.registry = registry.key();
        entry.target = ctx.accounts.target.key();
        entry.target_program = *ctx.accounts.target.owner;
        entry.name = name;
        entry.tags = tags;
        entry.bump = ctx.bumps.entry;
        registry.entries.push(entry.key());
        emit_cpi!(EntryRegistered {
            entry: entry.key(),
            target: entry.target,
        });
        Ok(())
    }

    pub fn deposit_via_registry(ctx: Context<DepositViaRegistry>, amount: u64) -> Result<()> {
        let accounts = xray_vault::cpi::accounts::Deposit {
            depositor: ctx.accounts.depositor.to_account_info(),
            vault: ctx.accounts.vault.to_account_info(),
            receipt: ctx.accounts.receipt.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        };
        xray_vault::cpi::deposit(CpiContext::new(xray_vault::ID, accounts), amount)
    }
}

#[derive(Accounts)]
pub struct InitRegistry<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Registry::INIT_SPACE,
        seeds = [REGISTRY_SEED, authority.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, Registry>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [REGISTRY_SEED, authority.key().as_ref()],
        bump = registry.bump,
        has_one = authority
    )]
    pub registry: Account<'info, Registry>,
    /// CHECK: any account can be registered; its owner is recorded.
    pub target: UncheckedAccount<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + Entry::INIT_SPACE,
        seeds = [ENTRY_SEED, target.key().as_ref()],
        bump
    )]
    pub entry: Account<'info, Entry>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositViaRegistry<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(seeds = [ENTRY_SEED, vault.key().as_ref()], bump = entry.bump)]
    pub entry: Account<'info, Entry>,
    /// CHECK: validated by the vault program.
    #[account(mut, address = entry.target)]
    pub vault: UncheckedAccount<'info>,
    /// CHECK: initialized by the vault program.
    #[account(mut)]
    pub receipt: Signer<'info>,
    pub vault_program: Program<'info, XrayVault>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Registry {
    pub authority: Pubkey,
    #[max_len(8)]
    pub entries: Vec<Pubkey>,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Entry {
    pub registry: Pubkey,
    pub target: Pubkey,
    pub target_program: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(4, 16)]
    pub tags: Vec<String>,
    pub bump: u8,
}

#[event]
pub struct EntryRegistered {
    pub entry: Pubkey,
    pub target: Pubkey,
}

#[error_code]
pub enum RegistryError {
    #[msg("Registry already holds the maximum number of entries")]
    RegistryFull,
}
