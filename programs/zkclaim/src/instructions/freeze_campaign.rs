use anchor_lang::prelude::*;

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Campaign, CampaignFrozen, CampaignState, Tree},
};

#[derive(Accounts)]
pub struct FreezeCampaign<'info> {
    pub admin: Signer<'info>,
    #[account(
        mut,
        has_one = admin @ ErrorCode::Unauthorized,
        constraint = campaign.state == CampaignState::Registering @ ErrorCode::NotRegistering
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        seeds = [TREE_SEED, campaign.key().as_ref()],
        bump
    )]
    pub tree: AccountLoader<'info, Tree>,
}

pub fn handle_freeze_campaign(ctx: Context<FreezeCampaign>) -> Result<()> {
    let tree = ctx.accounts.tree.load()?;
    require!(tree.next_index > 0, ErrorCode::NoRegistrations);

    // The root is copied from the program-computed tree; the admin cannot supply one.
    let campaign = &mut ctx.accounts.campaign;
    campaign.root = tree.current_root;
    campaign.state = CampaignState::Frozen;

    emit!(CampaignFrozen {
        campaign: campaign.key(),
        root: campaign.root,
        registrations: tree.next_index,
    });
    Ok(())
}
