use anchor_lang::{
    prelude::*,
    system_program::{allocate, assign, create_account, transfer, Allocate, Assign, CreateAccount, Transfer},
    Discriminator,
};

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Campaign, CampaignState, Eligible},
};

/// Remaining accounts: one writable `Eligible` PDA per entry in `wallets`, same order.
#[derive(Accounts)]
pub struct AddEligible<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        has_one = admin @ ErrorCode::Unauthorized,
        constraint = campaign.state == CampaignState::Registering @ ErrorCode::NotRegistering
    )]
    pub campaign: Account<'info, Campaign>,
    pub system_program: Program<'info, System>,
}

pub fn handle_add_eligible<'info>(
    ctx: Context<'info, AddEligible<'info>>,
    wallets: Vec<Pubkey>,
) -> Result<()> {
    require!(
        !wallets.is_empty() && wallets.len() == ctx.remaining_accounts.len(),
        ErrorCode::EligibleCountMismatch
    );

    let campaign_key = ctx.accounts.campaign.key();
    let space = 8 + Eligible::INIT_SPACE;
    let rent_lamports = Rent::get()?.minimum_balance(space);

    for (wallet, eligible) in wallets.iter().zip(ctx.remaining_accounts.iter()) {
        let (expected, bump) = Pubkey::find_program_address(
            &[ELIGIBLE_SEED, campaign_key.as_ref(), wallet.as_ref()],
            ctx.program_id,
        );
        require_keys_eq!(eligible.key(), expected, ErrorCode::InvalidEligibleAccount);
        require!(eligible.is_writable, ErrorCode::InvalidEligibleAccount);
        require_keys_eq!(*eligible.owner, System::id(), ErrorCode::AlreadyEligible);

        let bump = [bump];
        let seeds: &[&[u8]] = &[ELIGIBLE_SEED, campaign_key.as_ref(), wallet.as_ref(), &bump];
        init_pda(&ctx.accounts.admin, eligible, seeds, rent_lamports, space, ctx.program_id)?;

        eligible.try_borrow_mut_data()?[..8].copy_from_slice(Eligible::DISCRIMINATOR);
    }

    msg!("Added {} eligible wallets", wallets.len());
    Ok(())
}

/// Same as Anchor's `init`: works even if someone pre-funded the PDA with lamports
/// (a plain `create_account` would fail, letting anyone grief the allowlist).
fn init_pda<'info>(
    payer: &Signer<'info>,
    target: &AccountInfo<'info>,
    seeds: &[&[u8]],
    rent_lamports: u64,
    space: usize,
    owner: &Pubkey,
) -> Result<()> {
    let signer: &[&[&[u8]]] = &[seeds];
    let current = target.lamports();

    if current == 0 {
        return create_account(
            CpiContext::new_with_signer(
                System::id(),
                CreateAccount { from: payer.to_account_info(), to: target.clone() },
                signer,
            ),
            rent_lamports,
            space as u64,
            owner,
        );
    }

    let top_up = rent_lamports.saturating_sub(current);
    if top_up > 0 {
        transfer(
            CpiContext::new(
                System::id(),
                Transfer { from: payer.to_account_info(), to: target.clone() },
            ),
            top_up,
        )?;
    }
    allocate(
        CpiContext::new_with_signer(System::id(), Allocate { account_to_allocate: target.clone() }, signer),
        space as u64,
    )?;
    assign(
        CpiContext::new_with_signer(System::id(), Assign { account_to_assign: target.clone() }, signer),
        owner,
    )
}
