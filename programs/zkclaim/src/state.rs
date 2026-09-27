use anchor_lang::prelude::*;
use crate::constants::{MAX_LEAVES, TREE_DEPTH};

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum CampaignState {
    Registering,
    Frozen,
}

#[account]
#[derive(InitSpace)]
pub struct Campaign {
    pub admin: Pubkey,
    pub campaign_id: u64,
    pub mint: Pubkey,
    pub vault: Pubkey,
    pub amount: u64,
    pub state: CampaignState,
    /// Locked by `freeze` from `tree.current_root`; zero while registering.
    pub root: [u8; 32],
    pub bump: u8,
}

/// Incremental Merkle tree (Tornado-style). Zero-copy: ~8.5 KB would blow the stack via Borsh.
#[account(zero_copy)]
pub struct Tree {
    pub filled_subtrees: [[u8; 32]; TREE_DEPTH],
    pub current_root: [u8; 32],
    pub leaves: [[u8; 32]; MAX_LEAVES],
    pub next_index: u32,
}

impl Tree {
    pub const SIZE: usize = core::mem::size_of::<Tree>();
}

/// Empty marker: its existence at ["eligible", campaign, wallet] means the wallet may register once.
#[account]
#[derive(InitSpace)]
pub struct Eligible {}

/// Permanent marker at ["registration", campaign, wallet]: survives the `Eligible` close,
/// so a wallet can never register twice even if the admin re-adds it.
#[account]
#[derive(InitSpace)]
pub struct Registration {}

#[event]
pub struct Registered {
    pub index: u32,
    pub commitment: [u8; 32],
    pub root: [u8; 32],
}

#[event]
pub struct CampaignFrozen {
    pub campaign: Pubkey,
    pub root: [u8; 32],
    pub registrations: u32,
}

/// Empty marker at ["nullifier", campaign, nullifier]: exists iff that nullifier has claimed.
#[account]
#[derive(InitSpace)]
pub struct Nullifier {}

/// Deliberately carries no recipient, leaf index or commitment.
#[event]
pub struct Claimed {
    pub campaign: Pubkey,
    pub nullifier: [u8; 32],
}
