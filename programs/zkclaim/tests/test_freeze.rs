mod common;

use {
    anchor_lang::AccountDeserialize,
    common::*,
    solana_keypair::Keypair,
    solana_signer::Signer,
    zkclaim::state::{Campaign, CampaignState, Tree},
};

fn campaign(env: &Env) -> Campaign {
    let acc = env.svm.get_account(&env.campaign).unwrap();
    Campaign::try_deserialize(&mut acc.data.as_slice()).unwrap()
}

fn tree_root(env: &Env) -> [u8; 32] {
    let acc = env.svm.get_account(&env.tree).unwrap();
    bytemuck::from_bytes::<Tree>(&acc.data[8..]).current_root
}

/// Campaign with `n` registrations (commitments 1..=n, all below the modulus).
fn with_registrations(n: u8) -> Env {
    let mut env = created();
    for i in 1..=n {
        let user = eligible_user(&mut env);
        let mut commitment = [0u8; 32];
        commitment[31] = i;
        let ix = register_ix(&env, &user.pubkey(), commitment);
        send(&mut env.svm, ix, &user).unwrap();
    }
    env
}

#[test]
fn freeze_locks_program_computed_root() {
    let mut env = with_registrations(3);
    assert_eq!(campaign(&env).root, [0u8; 32]);

    let ix = freeze_campaign_ix(&env, &env.admin.pubkey());
    send(&mut env.svm, ix, &env.admin).unwrap();

    let c = campaign(&env);
    assert!(c.state == CampaignState::Frozen);
    assert_eq!(c.root, tree_root(&env));
    assert_ne!(c.root, [0u8; 32]);
}

#[test]
fn freeze_rejects_non_admin() {
    let mut env = with_registrations(1);
    let attacker = Keypair::new();
    env.svm.airdrop(&attacker.pubkey(), 1_000_000_000).unwrap();

    let ix = freeze_campaign_ix(&env, &attacker.pubkey());
    assert!(send(&mut env.svm, ix, &attacker).unwrap_err().contains("Unauthorized"));
    assert!(campaign(&env).state == CampaignState::Registering);
}

#[test]
fn freeze_rejects_empty_tree() {
    let mut env = created();
    let ix = freeze_campaign_ix(&env, &env.admin.pubkey());
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("NoRegistrations"));
}

#[test]
fn freeze_is_one_way_and_closes_allowlist() {
    let mut env = with_registrations(1);
    let ix = freeze_campaign_ix(&env, &env.admin.pubkey());
    send(&mut env.svm, ix, &env.admin).unwrap();
    let root = campaign(&env).root;

    let ix = freeze_campaign_ix(&env, &env.admin.pubkey());
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("NotRegistering"));

    let wallet = Keypair::new().pubkey();
    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[wallet], &[eligible_pda(&env.campaign, &wallet)]);
    assert!(send(&mut env.svm, ix, &env.admin).unwrap_err().contains("NotRegistering"));

    assert_eq!(campaign(&env).root, root);
}
