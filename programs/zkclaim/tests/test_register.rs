mod common;

use {
    anchor_lang::{prelude::Pubkey, AccountDeserialize, AccountSerialize},
    common::*,
    solana_account::Account,
    solana_poseidon::{hashv, Endianness, Parameters},
    solana_signer::Signer,
    zkclaim::{
        constants::{FIELD_MODULUS_BE, MAX_LEAVES, TREE_DEPTH, ZEROS},
        state::{Campaign, CampaignState, Tree},
    },
};

/// Golden vectors from circomlibjs 0.1.7 (the TS/circuit Poseidon): leaves are
/// Poseidon(secret) for secret = 1..=5, roots are after inserting the first n leaves.
const GOLDEN_LEAVES: [&str; 5] = [
    "29176100eaa962bdc1fe6c654d6a3c130e96a4d1168b33848b897dc502820133",
    "131d73cf6b30079aca0dff6a561cd0ee50b540879abe379a25a06b24bde2bebd",
    "0d4e4d24b890fe6799be4cf57ad13078ec0fbaa9fe91423ba8bbd0c2d7043bd4",
    "15e36f4ff92e2211fa8ed9f7af707f6c8c0f1442252a85150d2b8d2038890dfc",
    "2a267e27e712412e8eefec1e174ce85b1af2f2d9a8014fa4dc723abb4d27ef7d",
];
const GOLDEN_ROOTS: [&str; 5] = [
    "25a11a1cc10646a22aa8b4627ee99d4438f092b7a5b3e36da165b6822e12ad4b",
    "0134b5b0835a84966d4a6889575a65dee9c0328553f16490fa566396737581f8",
    "197cfd45fa5a725d0f83ee423278411d77fa44584e536351780ec75331fd9eb4",
    "11c43e0a6b33206964984418f1675fd793cff961ab285b6cda0381cc504b542d",
    "2fe190d74395c7777cb62e9455f02220bb162e8b434b96b0206475f937874729",
];

fn hex32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

fn poseidon(inputs: &[&[u8]]) -> [u8; 32] {
    hashv(Parameters::Bn254X5, Endianness::BigEndian, inputs).unwrap().to_bytes()
}

/// Reference: rebuild the whole depth-8 tree from scratch (empty leaves = 0).
fn full_root(leaves: &[[u8; 32]]) -> [u8; 32] {
    let mut layer = vec![[0u8; 32]; MAX_LEAVES];
    layer[..leaves.len()].copy_from_slice(leaves);
    for _ in 0..TREE_DEPTH {
        layer = layer.chunks(2).map(|p| poseidon(&[&p[0], &p[1]])).collect();
    }
    layer[0]
}

fn read_tree(env: &Env) -> Tree {
    let acc = env.svm.get_account(&env.tree).unwrap();
    *bytemuck::from_bytes::<Tree>(&acc.data[8..])
}

#[test]
fn off_chain_poseidon_matches_test_vectors() {
    let mut z = [0u8; 32];
    for level in 0..=TREE_DEPTH {
        assert_eq!(z, ZEROS[level], "zero[{level}]");
        z = poseidon(&[&z, &z]);
    }
    assert_eq!(full_root(&[]), ZEROS[TREE_DEPTH]);
}

#[test]
fn register_roots_match_circomlibjs() {
    let mut env = created();

    for (n, (leaf, root)) in GOLDEN_LEAVES.iter().zip(GOLDEN_ROOTS).enumerate() {
        let user = eligible_user(&mut env);
        let ix = register_ix(&env, &user.pubkey(), hex32(leaf));
        send(&mut env.svm, ix, &user).unwrap();

        let tree = read_tree(&env);
        assert_eq!(tree.next_index as usize, n + 1);
        assert_eq!(tree.leaves[n], hex32(leaf));
        assert_eq!(tree.current_root, hex32(root), "root after {} leaves", n + 1);
    }
}

#[test]
fn register_fills_tree_then_rejects() {
    let mut env = created();
    let mut leaves = Vec::with_capacity(MAX_LEAVES);

    for batch in 0..MAX_LEAVES.div_ceil(10) {
        let users: Vec<_> = (0..10.min(MAX_LEAVES - batch * 10))
            .map(|_| solana_keypair::Keypair::new())
            .collect();
        let wallets: Vec<Pubkey> = users.iter().map(|u| u.pubkey()).collect();
        let eligibles: Vec<Pubkey> = wallets.iter().map(|w| eligible_pda(&env.campaign, w)).collect();
        let ix = add_eligible_ix(&env, &env.admin.pubkey(), &wallets, &eligibles);
        send(&mut env.svm, ix, &env.admin).unwrap();

        for user in &users {
            env.svm.airdrop(&user.pubkey(), 10_000_000).unwrap();
            let mut secret = [0u8; 32];
            secret[24..].copy_from_slice(&(leaves.len() as u64 + 1).to_be_bytes());
            let commitment = poseidon(&[&secret]);
            let ix = register_ix(&env, &user.pubkey(), commitment);
            send(&mut env.svm, ix, user).unwrap();
            leaves.push(commitment);

            if matches!(leaves.len(), 1 | 2 | 3 | 7 | 8 | 128 | 129 | 255 | 256) {
                assert_eq!(read_tree(&env).current_root, full_root(&leaves), "after {}", leaves.len());
            }
        }
    }

    let tree = read_tree(&env);
    assert_eq!(tree.next_index as usize, MAX_LEAVES);
    assert_eq!(tree.leaves[..], leaves[..]);

    let user = eligible_user(&mut env);
    let ix = register_ix(&env, &user.pubkey(), hex32(GOLDEN_LEAVES[0]));
    assert!(send(&mut env.svm, ix, &user).unwrap_err().contains("TreeFull"));
}

#[test]
fn register_closes_eligible_and_is_rent_neutral_for_user() {
    let mut env = created();
    let user = eligible_user(&mut env);
    let eligible = eligible_pda(&env.campaign, &user.pubkey());
    let registration = registration_pda(&env.campaign, &user.pubkey());
    let before = env.svm.get_balance(&user.pubkey()).unwrap();

    let ix = register_ix(&env, &user.pubkey(), hex32(GOLDEN_LEAVES[0]));
    send(&mut env.svm, ix, &user).unwrap();

    assert!(env.svm.get_account(&eligible).map_or(true, |a| a.lamports == 0));
    let reg = env.svm.get_account(&registration).unwrap();
    assert_eq!(reg.owner, zkclaim::id());
    // Eligible and Registration are both 8-byte accounts: rent in == rent out, user pays only the fee.
    assert_eq!(before - env.svm.get_balance(&user.pubkey()).unwrap(), 5_000);
}

#[test]
fn register_rejects_second_registration_even_if_re_added() {
    let mut env = created();
    let user = eligible_user(&mut env);
    let ix = register_ix(&env, &user.pubkey(), hex32(GOLDEN_LEAVES[0]));
    send(&mut env.svm, ix, &user).unwrap();

    // Eligible is gone: plain retry fails.
    let ix = register_ix(&env, &user.pubkey(), hex32(GOLDEN_LEAVES[1]));
    assert!(send(&mut env.svm, ix, &user).unwrap_err().contains("AccountNotInitialized"));

    // Admin re-allowlists the same wallet: Registration marker still blocks it.
    let e = eligible_pda(&env.campaign, &user.pubkey());
    let ix = add_eligible_ix(&env, &env.admin.pubkey(), &[user.pubkey()], &[e]);
    send(&mut env.svm, ix, &env.admin).unwrap();
    let ix = register_ix(&env, &user.pubkey(), hex32(GOLDEN_LEAVES[1]));
    assert!(send(&mut env.svm, ix, &user).unwrap_err().contains("already in use"));

    assert_eq!(read_tree(&env).next_index, 1);
}

#[test]
fn register_rejects_non_eligible_and_foreign_eligible() {
    let mut env = created();
    let allowed = eligible_user(&mut env);
    let outsider = solana_keypair::Keypair::new();
    env.svm.airdrop(&outsider.pubkey(), 100_000_000).unwrap();

    let ix = register_ix(&env, &outsider.pubkey(), hex32(GOLDEN_LEAVES[0]));
    assert!(send(&mut env.svm, ix, &outsider).unwrap_err().contains("AccountNotInitialized"));

    // Outsider tries to consume the allowlisted wallet's Eligible account.
    let mut ix = register_ix(&env, &outsider.pubkey(), hex32(GOLDEN_LEAVES[0]));
    ix.accounts[3].pubkey = eligible_pda(&env.campaign, &allowed.pubkey());
    assert!(send(&mut env.svm, ix, &outsider).unwrap_err().contains("ConstraintSeeds"));

    assert_eq!(read_tree(&env).next_index, 0);
}

#[test]
fn register_rejects_invalid_commitments() {
    let mut env = created();
    let user = eligible_user(&mut env);

    let mut just_below = FIELD_MODULUS_BE;
    just_below[31] -= 1;
    for bad in [[0u8; 32], FIELD_MODULUS_BE, [0xff; 32]] {
        let ix = register_ix(&env, &user.pubkey(), bad);
        assert!(send(&mut env.svm, ix, &user).unwrap_err().contains("InvalidCommitment"));
    }
    let ix = register_ix(&env, &user.pubkey(), just_below);
    send(&mut env.svm, ix, &user).unwrap();
    assert_eq!(read_tree(&env).leaves[0], just_below);
}

#[test]
fn register_rejects_when_frozen() {
    let mut env = created();
    let user = eligible_user(&mut env);

    // No freeze instruction yet: flip the state directly.
    let acc = env.svm.get_account(&env.campaign).unwrap();
    let mut campaign = Campaign::try_deserialize(&mut acc.data.as_slice()).unwrap();
    campaign.state = CampaignState::Frozen;
    let mut data = Vec::with_capacity(acc.data.len());
    campaign.try_serialize(&mut data).unwrap();
    env.svm.set_account(env.campaign, Account { data, ..acc }).unwrap();

    let ix = register_ix(&env, &user.pubkey(), hex32(GOLDEN_LEAVES[0]));
    assert!(send(&mut env.svm, ix, &user).unwrap_err().contains("NotRegistering"));
}
