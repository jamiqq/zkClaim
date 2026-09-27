use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Campaign, CampaignState, Tree},
};

#[derive(Accounts)]
#[instruction(campaign_id: u64)]
pub struct CreateCampaign<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Campaign::INIT_SPACE,
        seeds = [CAMPAIGN_SEED, campaign_id.to_le_bytes().as_ref()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        init,
        payer = admin,
        space = 8 + Tree::SIZE,
        seeds = [TREE_SEED, campaign.key().as_ref()],
        bump
    )]
    pub tree: AccountLoader<'info, Tree>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = admin,
        associated_token::mint = mint,
        associated_token::authority = campaign,
        associated_token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_create_campaign(
    ctx: Context<CreateCampaign>,
    campaign_id: u64,
    amount: u64,
) -> Result<()> {
    require!(amount > 0, ErrorCode::InvalidAmount);

    let campaign = &mut ctx.accounts.campaign;
    campaign.admin = ctx.accounts.admin.key();
    campaign.campaign_id = campaign_id;
    campaign.mint = ctx.accounts.mint.key();
    campaign.vault = ctx.accounts.vault.key();
    campaign.amount = amount;
    campaign.state = CampaignState::Registering;
    campaign.root = [0u8; 32];
    campaign.bump = ctx.bumps.campaign;

    // Empty tree: filled_subtrees[i] = zero[i], root = zero[depth]. Leaves are already zeroed.
    let mut tree = ctx.accounts.tree.load_init()?;
    tree.filled_subtrees.copy_from_slice(&ZEROS[..TREE_DEPTH]);
    tree.current_root = ZEROS[TREE_DEPTH];
    tree.next_index = 0;

    msg!("Campaign {} created, amount {}", campaign_id, amount);
    Ok(())
}
