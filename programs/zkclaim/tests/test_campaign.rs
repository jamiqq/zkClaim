mod common;

use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, Discriminator},
    anchor_spl::token::{self, spl_token},
    common::*,
    solana_keypair::Keypair,
    solana_program_pack::Pack,
    solana_signer::Signer,
    zkclaim::{
        constants::{TREE_DEPTH, ZEROS},
        state::{Campaign, CampaignState, Eligible, Tree},
    },
};

#[test]
fn create_campaign_initializes_state() {
    let env = created();

    let acc = env.svm.get_account(&env.campaign).unwrap();
    let campaign = Campaign::try_deserialize(&mut acc.data.as_slice()).unwrap();
    assert_eq!(campaign.admin, env.admin.pubkey());
    assert_eq!(campaign.campaign_id, CAMPAIGN_ID);
    assert_eq!(campaign.mint, env.mint);
    assert_eq!(campaign.vault, env.vault);
    assert_eq!(campaign.amount, AMOUNT);
    assert!(campaign.state == CampaignState::Registering);
    assert_eq!(campaign.root, [0u8; 32]);

    let acc = env.svm.get_account(&env.tree).unwrap();
    assert_eq!(acc.owner, zkclaim::id());
    assert_eq!(&acc.data[..8], Tree::DISCRIMINATOR);
    let tree: &Tree = bytemuck::from_bytes(&acc.data[8..]);
    assert_eq!(tree.next_index, 0);
    assert_eq!(tree.current_root, ZEROS[TREE_DEPTH]);
    assert_eq!(tree.filled_subtrees[..], ZEROS[..TREE_DEPTH]);
    assert!(tree.leaves.iter().all(|l| *l == [0u8; 32]));

    let acc = env.svm.get_account(&env.vault).unwrap();
    assert_eq!(acc.owner, token::ID);
    let vault = spl_token::state::Account::unpack(&acc.data).unwrap();
    assert_eq!(vault.owner, env.campaign);
    assert_eq!(vault.mint, env.mint);
    assert_eq!(vault.amount, 0);
}

#[test]
fn create_campaign_rejects_zero_amount_and_duplicates() {
    let mut env = setup();
    let ix = create_campaign_ix(&env, 0);
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("InvalidAmount"));

    let ix = create_campaign_ix(&env, AMOUNT);
    send(&mut env.svm, ix, &env.admin).unwrap();
    let ix = create_campaign_ix(&env, AMOUNT);
    assert!(send(&mut env.svm, ix, &env.admin).is_err());
}

#[test]
fn add_eligible_creates_markers_for_batch_of_ten() {
    let mut env = created();
    let wallets: Vec<Pubkey> = (0..10).map(|_| Pubkey::new_unique()).collect();
    let eligibles: Vec<Pubkey> = wallets.iter().map(|w| eligible_pda(&env.campaign, w)).collect();

    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &wallets, &eligibles);
    send(&mut env.svm, ix, &env.admin).unwrap();

    for e in &eligibles {
        let acc = env.svm.get_account(e).unwrap();
        assert_eq!(acc.owner, zkclaim::id());
        assert_eq!(acc.data, Eligible::DISCRIMINATOR);
        assert!(Eligible::try_deserialize(&mut acc.data.as_slice()).is_ok());
    }
}

#[test]
fn add_eligible_rejects_non_admin() {
    let mut env = created();
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();
    let wallet = Pubkey::new_unique();
    let eligible = eligible_pda(&env.campaign, &wallet);

    let ix = add_eligible_ix(&env, &attacker.pubkey(), &[wallet], &[eligible]);
    assert!(send(&mut env.svm, ix, &attacker).unwrap_err().contains("Unauthorized"));
}

#[test]
fn add_eligible_rejects_wrong_pda_and_count_mismatch() {
    let mut env = created();
    let wallet = Pubkey::new_unique();
    let other = eligible_pda(&env.campaign, &Pubkey::new_unique());

    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[wallet], &[other]);
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("InvalidEligibleAccount"));

    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[wallet], &[]);
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("EligibleCountMismatch"));
}

#[test]
fn add_eligible_rejects_duplicate_wallet() {
    let mut env = created();
    let wallet = Pubkey::new_unique();
    let eligible = eligible_pda(&env.campaign, &wallet);

    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[wallet], &[eligible]);
    send(&mut env.svm, ix, &env.admin).unwrap();
    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[wallet], &[eligible]);
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("AlreadyEligible"));
}

#[test]
fn add_eligible_survives_prefunded_pda() {
    let mut env = created();
    let wallet = Pubkey::new_unique();
    let eligible = eligible_pda(&env.campaign, &wallet);
    // Griefer sends lamports to the PDA before the admin allowlists it.
    env.svm.airdrop(&eligible, 1).unwrap();

    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[wallet], &[eligible]);
    send(&mut env.svm, ix, &env.admin).unwrap();

    let acc = env.svm.get_account(&eligible).unwrap();
    assert_eq!(acc.owner, zkclaim::id());
    assert_eq!(acc.data, Eligible::DISCRIMINATOR);
    assert!(acc.lamports >= env.svm.minimum_balance_for_rent_exemption(8));
}
