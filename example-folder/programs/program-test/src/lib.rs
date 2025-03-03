use anchor_lang::prelude::*;
use anchor_lang::system_program;

declare_id!("7Yi8tUvTPwop1ysZjvBmYefmoG9DUT6qdYZxqvkzwXmr");

#[program]
pub mod program_test {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Initializing program...");
        msg!("Program ID: {:?}", ctx.program_id);

        // Default values for PDA
        ctx.accounts.pda_account.info1 = 100;
        ctx.accounts.pda_account.info2 = -50;
        ctx.accounts.pda_account.info3 = true;
        ctx.accounts.pda_account.name = "InitialPDA".to_string();

        // Default values for normal account
        ctx.accounts.normal_account.bool1 = false;
        ctx.accounts.normal_account.bool2 = true;
        ctx.accounts.normal_account.bool3 = false;
        ctx.accounts.normal_account.counter = 0;

        Ok(())
    }

    pub fn update_pda_info(ctx: Context<UpdatePDAInfo>, new_info1: u64, new_info2: i128, new_info3: bool, new_name: String) -> Result<()> {
        let pda = &mut ctx.accounts.pda_account;
        pda.info1 = new_info1;
        pda.info2 = new_info2;
        pda.info3 = new_info3;
        pda.name = new_name;

        msg!("PDA Updated: info1={}, info2={}, info3={}, name={}", pda.info1, pda.info2, pda.info3, pda.name);
        Ok(())
    }

    pub fn toggle_normal_account(ctx: Context<ToggleNormalAccount>) -> Result<()> {
        let account = &mut ctx.accounts.normal_account;
        account.bool1 = !account.bool1;
        account.bool2 = !account.bool2;
        account.bool3 = !account.bool3;
        account.counter += 1;

        msg!("NormalAccount toggled. Counter: {}", account.counter);
        Ok(())
    }

    pub fn transfer_lamports(ctx: Context<TransferLamports>, amount: u64) -> Result<()> {
        let from = &ctx.accounts.from;
        let to = &ctx.accounts.to;
        
        system_program::transfer(
            CpiContext::new(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: from.to_account_info(),
                    to: to.to_account_info(),
                },
            ),
            amount,
        )?;
    
        msg!("Transferred {} lamports from {:?} to {:?}", amount, from.key(), to.key());
        Ok(())
    }
    
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    pub system_program: Program<'info, System>,

    #[account(mut)]
    pub user: Signer<'info>,

    #[account(init,
        payer = user,
        space = 120,
        seeds = [],
        bump
    )]
    pub pda_account: Account<'info, PDAaccountInfo>,

    #[account(init,
        payer = user,
        space = 120,
        seeds = [b"1234"],
        bump
    )]
    pub pda_account2: Account<'info, PDAaccountInfo>,

    #[account(init, payer=user, space = 160)]
    pub normal_account: Account<'info, NormalAccount>,
}

#[derive(Accounts)]
pub struct UpdatePDAInfo<'info> {
    #[account(mut)]
    pub pda_account: Account<'info, PDAaccountInfo>,
}

#[derive(Accounts)]
pub struct ToggleNormalAccount<'info> {
    #[account(mut)]
    pub normal_account: Account<'info, NormalAccount>,
}

#[derive(Accounts)]
pub struct TransferLamports<'info> {
    #[account(mut)]
    pub from: Signer<'info>,
    #[account(mut)]
    pub to: SystemAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct PDAaccountInfo {
    pub info1: u64,
    pub info2: i128,
    pub info3: bool,
    pub name: String, // New field
}

#[account]
pub struct NormalAccount {
    pub bool1: bool,
    pub bool2: bool,
    pub bool3: bool,
    pub counter: u32, // Tracks how many times toggled
}

#[error_code]
pub enum CustomError {
    #[msg("Not enough lamports to complete transaction.")]
    InsufficientFunds,
}
