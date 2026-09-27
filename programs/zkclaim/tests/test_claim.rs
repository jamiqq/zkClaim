mod common;

use {
    anchor_lang::{prelude::Pubkey, solana_program::instruction::Instruction, AccountDeserialize},
    anchor_spl::{associated_token::spl_associated_token_account, token},
    common::*,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    zkclaim::{
        constants::{FIELD_MODULUS_BE, ZEROS},
        state::Campaign,
    },
};

/// P1 fixture (programs/zkclaim/tests/fixtures): a proof for leaf 3 of a 5-leaf tree,
/// campaign_id = 1, fixed recipient. Registering the same 5 leaves reproduces its root.
struct Fixture {
    proof: [u8; 256],
    inputs: [[u8; 32]; 5],
    leaves: Vec<[u8; 32]>,
    recipient: Pubkey,
}

const FIXTURE_CAMPAIGN_ID: u64 = 1;

fn fixture() -> Fixture {
    let proof: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/proof_solana.json")).unwrap();
    let meta: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/input.example.meta.json")).unwrap();

    let p = proof["proof"].as_str().unwrap();
    let mut proof_bytes = [0u8; 256];
    for (i, chunk) in proof_bytes.chunks_mut(32).enumerate() {
        chunk.copy_from_slice(&from_hex32(&p[64 * i..64 * (i + 1)]));
    }
    let mut inputs = [[0u8; 32]; 5];
    for (i, h) in proof["public_inputs"].as_array().unwrap().iter().enumerate() {
        inputs[i] = from_hex32(h.as_str().unwrap());
    }
    let leaves = meta["leaves"].as_array().unwrap().iter().map(|l| dec_to_be32(l.as_str().unwrap())).collect();
    let recipient = meta["recipient"].as_str().unwrap().parse().unwrap();

    Fixture { proof: proof_bytes, inputs, leaves, recipient }
}

/// Campaign with the fixture's 5 leaves registered, frozen, vault funded for 3 claims.
fn frozen_campaign(campaign_id: u64, fx: &Fixture) -> Env {
    let mut env = created_with_id(campaign_id);
    for leaf in &fx.leaves {
        let user = eligible_user(&mut env);
        let ix = register_ix(&env, &user.pubkey(), *leaf);
        send(&mut env.svm, ix, &user).unwrap();
    }
    let ix = freeze_campaign_ix(&env, &env.admin.pubkey());
    send(&mut env.svm, ix, &env.admin).unwrap();
    fund_vault(&mut env, AMOUNT * 3);
    env
}

fn funded_relayer(env: &mut Env) -> Keypair {
    let relayer = Keypair::new();
    env.svm.airdrop(&relayer.pubkey(), 1_000_000_000).unwrap();
    relayer
}

/// The relayer's real transaction: compute budget, idempotent ATA for the recipient, claim.
fn claim_tx(env: &mut Env, relayer: &Keypair, recipient: &Pubkey, proof: [u8; 256], nullifier: [u8; 32]) -> Result<(), String> {
    let ixs: Vec<Instruction> = vec![
        compute_limit_ix(400_000),
        spl_associated_token_account::instruction::create_associated_token_account_idempotent(
            &relayer.pubkey(),
            recipient,
            &env.mint,
            &token::ID,
        ),
        claim_ix(env, &relayer.pubkey(), recipient, proof, nullifier),
    ];
    env.svm.expire_blockhash();
    let msg = Message::new_with_blockhash(&ixs, Some(&relayer.pubkey()), &env.svm.latest_blockhash());
    let msg = VersionedMessage::Legacy(msg);
    let tx_size = 1 + 64 + msg.serialize().len();
    assert!(tx_size <= 1232, "claim tx is {tx_size} bytes");
    let tx = VersionedTransaction::try_new(msg, &[relayer]).unwrap();
    env.svm
        .send_transaction(tx)
        .map(|meta| println!("claim tx: {tx_size} bytes, {} CU", meta.compute_units_consumed))
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

#[test]
fn fixture_matches_program_conventions() {
    let fx = fixture();
    let meta: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/input.example.meta.json")).unwrap();
    for (i, z) in meta["zeros"].as_array().unwrap().iter().enumerate() {
        assert_eq!(dec_to_be32(z.as_str().unwrap()), ZEROS[i], "zero[{i}]");
    }
    let key = fx.recipient.to_bytes();
    assert_eq!(fx.inputs[2][16..], key[..16], "recipient_hi");
    assert_eq!(fx.inputs[3][16..], key[16..], "recipient_lo");
    assert_eq!(fx.inputs[4][24..], FIXTURE_CAMPAIGN_ID.to_be_bytes(), "campaign_id");
}

#[test]
fn claim_pays_recipient_once() {
    let fx = fixture();
    let mut env = frozen_campaign(FIXTURE_CAMPAIGN_ID, &fx);

    let acc = env.svm.get_account(&env.campaign).unwrap();
    let campaign = Campaign::try_deserialize(&mut acc.data.as_slice()).unwrap();
    assert_eq!(campaign.root, fx.inputs[0], "on-chain root must equal the proof's root");

    let relayer = funded_relayer(&mut env);
    let nullifier = fx.inputs[1];
    claim_tx(&mut env, &relayer, &fx.recipient, fx.proof, nullifier).unwrap();

    let ata = anchor_spl::associated_token::get_associated_token_address(&fx.recipient, &env.mint);
    assert_eq!(token_balance(&env, &ata), AMOUNT);
    assert_eq!(token_balance(&env, &env.vault), AMOUNT * 2);
    let marker = env.svm.get_account(&nullifier_pda(&env.campaign, &nullifier)).unwrap();
    assert_eq!(marker.owner, zkclaim::id());
    assert_eq!(env.svm.get_balance(&fx.recipient).unwrap_or(0), 0, "recipient needs no SOL");

    // Same proof again, even from another relayer: nullifier account already exists.
    let other = funded_relayer(&mut env);
    let err = claim_tx(&mut env, &other, &fx.recipient, fx.proof, nullifier).unwrap_err();
    assert!(err.contains("already in use"), "{err}");
    assert_eq!(token_balance(&env, &ata), AMOUNT);
}

#[test]
fn claim_rejects_swapped_recipient() {
    let fx = fixture();
    let mut env = frozen_campaign(FIXTURE_CAMPAIGN_ID, &fx);
    let relayer = funded_relayer(&mut env);
    // Front-running: copy the proof, swap in your own wallet.
    let thief = Keypair::new().pubkey();
    let err = claim_tx(&mut env, &relayer, &thief, fx.proof, fx.inputs[1]).unwrap_err();
    assert!(err.contains("ProofInvalid"), "{err}");
    assert_eq!(token_balance(&env, &env.vault), AMOUNT * 3);
}

#[test]
fn claim_rejects_tampered_proof_and_other_nullifier() {
    let fx = fixture();
    let mut env = frozen_campaign(FIXTURE_CAMPAIGN_ID, &fx);
    let relayer = funded_relayer(&mut env);

    let mut bad_proof = fx.proof;
    bad_proof[200] ^= 1;
    let err = claim_tx(&mut env, &relayer, &fx.recipient, bad_proof, fx.inputs[1]).unwrap_err();
    assert!(err.contains("ProofInvalid"), "{err}");

    let mut other_nullifier = fx.inputs[1];
    other_nullifier[31] ^= 1;
    let err = claim_tx(&mut env, &relayer, &fx.recipient, fx.proof, other_nullifier).unwrap_err();
    assert!(err.contains("ProofInvalid"), "{err}");
}

#[test]
fn claim_rejects_nullifier_alias_above_modulus() {
    let fx = fixture();
    let mut env = frozen_campaign(FIXTURE_CAMPAIGN_ID, &fx);
    let relayer = funded_relayer(&mut env);
    // nullifier + p is the same field element under a different PDA.
    let mut alias = [0u8; 32];
    let mut carry = 0u16;
    for i in (0..32).rev() {
        let v = fx.inputs[1][i] as u16 + FIELD_MODULUS_BE[i] as u16 + carry;
        alias[i] = v as u8;
        carry = v >> 8;
    }
    assert_eq!(carry, 0);
    let err = claim_tx(&mut env, &relayer, &fx.recipient, fx.proof, alias).unwrap_err();
    assert!(err.contains("InvalidNullifier"), "{err}");
}

#[test]
fn claim_rejects_other_campaign_with_same_root() {
    // Cross-campaign replay: identical tree, different campaign_id.
    let fx = fixture();
    let mut env = frozen_campaign(FIXTURE_CAMPAIGN_ID + 1, &fx);
    let acc = env.svm.get_account(&env.campaign).unwrap();
    assert_eq!(Campaign::try_deserialize(&mut acc.data.as_slice()).unwrap().root, fx.inputs[0]);

    let relayer = funded_relayer(&mut env);
    let err = claim_tx(&mut env, &relayer, &fx.recipient, fx.proof, fx.inputs[1]).unwrap_err();
    assert!(err.contains("ProofInvalid"), "{err}");
}

#[test]
fn claim_rejects_before_freeze() {
    let fx = fixture();
    let mut env = created_with_id(FIXTURE_CAMPAIGN_ID);
    for leaf in &fx.leaves {
        let user = eligible_user(&mut env);
        let ix = register_ix(&env, &user.pubkey(), *leaf);
        send(&mut env.svm, ix, &user).unwrap();
    }
    fund_vault(&mut env, AMOUNT);
    let relayer = funded_relayer(&mut env);
    let err = claim_tx(&mut env, &relayer, &fx.recipient, fx.proof, fx.inputs[1]).unwrap_err();
    assert!(err.contains("NotFrozen"), "{err}");
}

#[test]
fn claim_rejects_foreign_vault() {
    let fx = fixture();
    let mut env = frozen_campaign(FIXTURE_CAMPAIGN_ID, &fx);
    let relayer = funded_relayer(&mut env);
    let mut ix = claim_ix(&env, &relayer.pubkey(), &fx.recipient, fx.proof, fx.inputs[1]);
    let vault = env.vault;
    ix.accounts.iter_mut().find(|m| m.pubkey == vault).unwrap().pubkey =
        anchor_spl::associated_token::get_associated_token_address(&relayer.pubkey(), &env.mint);
    let err = send(&mut env.svm, ix, &relayer).unwrap_err();
    assert!(err.contains("ConstraintHasOne") || err.contains("AccountNotInitialized"), "{err}");
}
