pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod verifier;
pub mod verifying_key;

use anchor_lang::prelude::*;

pub use constants::*;
pub use instructions::*;
pub use state::*;

declare_id!("EHsj9Fz1QuPB9drLUF9SPk63y23pXcSXzfr65MjD3nT3");

#[program]
pub mod zkclaim {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        crate::instructions::initialize::handle_initialize(ctx)
    }

    pub fn increment(ctx: Context<Increment>) -> Result<()> {
        crate::instructions::increment::handle_increment(ctx)
    }

    pub fn create_campaign(ctx: Context<CreateCampaign>, campaign_id: u64, amount: u64) -> Result<()> {
        crate::instructions::create_campaign::handle_create_campaign(ctx, campaign_id, amount)
    }

    pub fn add_eligible<'info>(
        ctx: Context<'info, AddEligible<'info>>,
        wallets: Vec<Pubkey>,
    ) -> Result<()> {
        crate::instructions::add_eligible::handle_add_eligible(ctx, wallets)
    }

    pub fn register(ctx: Context<Register>, commitment: [u8; 32]) -> Result<()> {
        crate::instructions::register::handle_register(ctx, commitment)
    }

    pub fn freeze_campaign(ctx: Context<FreezeCampaign>) -> Result<()> {
        crate::instructions::freeze_campaign::handle_freeze_campaign(ctx)
    }

    pub fn claim(ctx: Context<Claim>, proof: [u8; 256], nullifier: [u8; 32]) -> Result<()> {
        crate::instructions::claim::handle_claim(ctx, proof, nullifier)
    }
}
