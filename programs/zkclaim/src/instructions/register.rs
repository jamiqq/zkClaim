use anchor_lang::prelude::*;
use solana_poseidon::{hashv, Endianness, Parameters};

use crate::{
    constants::*,
    error::ErrorCode,
    state::{Campaign, CampaignState, Eligible, Registered, Registration, Tree},
};

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        constraint = campaign.state == CampaignState::Registering @ ErrorCode::NotRegistering
    )]
    pub campaign: Account<'info, Campaign>,
    #[account(
        mut,
        seeds = [TREE_SEED, campaign.key().as_ref()],
        bump
    )]
    pub tree: AccountLoader<'info, Tree>,
    /// Missing account = wallet not allowlisted (or already registered).
    #[account(
        mut,
        close = user,
        seeds = [ELIGIBLE_SEED, campaign.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub eligible: Account<'info, Eligible>,
    #[account(
        init,
        payer = user,
        space = 8 + Registration::INIT_SPACE,
        seeds = [REGISTRATION_SEED, campaign.key().as_ref(), user.key().as_ref()],
        bump
    )]
    pub registration: Account<'info, Registration>,
    pub system_program: Program<'info, System>,
}

pub fn handle_register(ctx: Context<Register>, commitment: [u8; 32]) -> Result<()> {
    require!(
        commitment != [0u8; 32] && commitment < FIELD_MODULUS_BE,
        ErrorCode::InvalidCommitment
    );

    let mut tree = ctx.accounts.tree.load_mut()?;
    let index = tree.next_index;
    require!((index as usize) < MAX_LEAVES, ErrorCode::TreeFull);

    // Incremental insert (Tornado-style): bit i of the index says whether the node at
    // level i is a right child. Left siblings are cached in filled_subtrees; right
    // siblings of the newest leaf are always empty subtrees (ZEROS).
    let mut node = commitment;
    let mut path = index;
    for level in 0..TREE_DEPTH {
        node = if path & 1 == 0 {
            tree.filled_subtrees[level] = node;
            poseidon2(&node, &ZEROS[level])?
        } else {
            poseidon2(&tree.filled_subtrees[level], &node)?
        };
        path >>= 1;
    }

    tree.leaves[index as usize] = commitment;
    tree.current_root = node;
    tree.next_index = index.checked_add(1).ok_or(ErrorCode::TreeFull)?;

    emit!(Registered { index, commitment, root: node });
    Ok(())
}

/// circomlib-compatible Poseidon(left, right) over BN254, big-endian, via the sol_poseidon syscall.
fn poseidon2(left: &[u8; 32], right: &[u8; 32]) -> Result<[u8; 32]> {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &[left, right])
        .map(|h| h.to_bytes())
        .map_err(|_| error!(ErrorCode::PoseidonFailed))
}
