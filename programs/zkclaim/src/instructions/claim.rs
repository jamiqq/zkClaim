use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{transfer_checked, Mint, Token, TokenAccount, TransferChecked},
};

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Campaign, CampaignState, Claimed, Nullifier},
    verifier::verify_proof,
    verifying_key::NR_PUBLIC_INPUTS,
};

#[derive(Accounts)]
#[instruction(proof: [u8; 256], nullifier: [u8; 32])]
pub struct Claim<'info> {
    /// Fee payer; pays rent for the nullifier marker. Not bound by the proof.
    #[account(mut)]
    pub relayer: Signer<'info>,
    #[account(
        has_one = mint,
        has_one = vault,
        constraint = campaign.state == CampaignState::Frozen @ ErrorCode::NotFrozen
    )]
    pub campaign: Account<'info, Campaign>,
    /// `init` fails if this nullifier already claimed.
    #[account(
        init,
        payer = relayer,
        space = 8 + Nullifier::INIT_SPACE,
        seeds = [NULLIFIER_SEED, campaign.key().as_ref(), nullifier.as_ref()],
        bump
    )]
    pub nullifier_account: Account<'info, Nullifier>,
    /// CHECK: any wallet; its key is a public input, so the proof binds it.
    pub recipient: UncheckedAccount<'info>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = recipient,
        associated_token::token_program = token_program
    )]
    pub recipient_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    pub mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn handle_claim(ctx: Context<Claim>, proof: [u8; 256], nullifier: [u8; 32]) -> Result<()> {
    // A value >= p would alias a valid nullifier mod p under a different PDA: a second claim.
    require!(nullifier < FIELD_MODULUS_BE, ErrorCode::InvalidNullifier);

    let campaign = &ctx.accounts.campaign;
    verify_proof(&proof, &public_inputs(campaign, &nullifier, &ctx.accounts.recipient.key()))?;

    let id_bytes = campaign.campaign_id.to_le_bytes();
    let signer: &[&[&[u8]]] = &[&[CAMPAIGN_SEED, id_bytes.as_ref(), &[campaign.bump]]];
    transfer_checked(
        CpiContext::new_with_signer(
            Token::id(),
            TransferChecked {
                from: ctx.accounts.vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.recipient_token.to_account_info(),
                authority: campaign.to_account_info(),
            },
            signer,
        ),
        campaign.amount,
        ctx.accounts.mint.decimals,
    )?;

    emit!(Claimed { campaign: campaign.key(), nullifier });
    Ok(())
}

/// Circuit order: [root, nullifier, recipient_hi, recipient_lo, campaign_id], 32-byte BE each.
/// Everything except the nullifier comes from checked accounts, never from the client.
fn public_inputs(
    campaign: &Campaign,
    nullifier: &[u8; 32],
    recipient: &Pubkey,
) -> [[u8; 32]; NR_PUBLIC_INPUTS] {
    let key = recipient.to_bytes();
    let mut hi = [0u8; 32];
    let mut lo = [0u8; 32];
    hi[16..].copy_from_slice(&key[..16]);
    lo[16..].copy_from_slice(&key[16..]);
    let mut id = [0u8; 32];
    id[24..].copy_from_slice(&campaign.campaign_id.to_be_bytes());
    [campaign.root, *nullifier, hi, lo, id]
}
