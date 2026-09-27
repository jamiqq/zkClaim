#![allow(dead_code)]

use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        InstructionData, ToAccountMetas,
    },
    anchor_spl::{
        associated_token::{self, get_associated_token_address},
        token::{self, spl_token},
    },
    litesvm::LiteSVM,
    solana_account::Account,
    solana_keypair::Keypair,
    solana_message::{Message, VersionedMessage},
    solana_program_option::COption,
    solana_program_pack::Pack,
    solana_signer::Signer,
    solana_transaction::versioned::VersionedTransaction,
    zkclaim::constants::{CAMPAIGN_SEED, ELIGIBLE_SEED, NULLIFIER_SEED, REGISTRATION_SEED, TREE_SEED},
};

pub const CAMPAIGN_ID: u64 = 42;
pub const AMOUNT: u64 = 1_000_000;

pub struct Env {
    pub svm: LiteSVM,
    pub campaign_id: u64,
    pub admin: Keypair,
    pub mint: Pubkey,
    pub campaign: Pubkey,
    pub tree: Pubkey,
    pub vault: Pubkey,
}

pub fn setup() -> Env {
    setup_with_id(CAMPAIGN_ID)
}

pub fn setup_with_id(campaign_id: u64) -> Env {
    let mut svm = LiteSVM::new();
    let bytes = include_bytes!(concat!(
        env!("CARGO_TARGET_TMPDIR"),
        "/../deploy/zkclaim.so"
    ));
    svm.add_program(zkclaim::id(), bytes).unwrap();

    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 10_000_000_000).unwrap();

    let mint = Pubkey::new_unique();
    let mut data = [0u8; spl_token::state::Mint::LEN];
    spl_token::state::Mint::pack(
        spl_token::state::Mint {
            mint_authority: COption::Some(admin.pubkey()),
            supply: 0,
            decimals: 6,
            is_initialized: true,
            freeze_authority: COption::None,
        },
        &mut data,
    )
    .unwrap();
    svm.set_account(
        mint,
        Account {
            lamports: 1_000_000_000,
            data: data.to_vec(),
            owner: token::ID,
            executable: false,
            rent_epoch: 0,
        },
    )
    .unwrap();

    let campaign = campaign_pda(campaign_id);
    let tree = Pubkey::find_program_address(&[TREE_SEED, campaign.as_ref()], &zkclaim::id()).0;
    let vault = get_associated_token_address(&campaign, &mint);

    Env { svm, campaign_id, admin, mint, campaign, tree, vault }
}

/// `setup()` + a successful `create_campaign`.
pub fn created() -> Env {
    created_with_id(CAMPAIGN_ID)
}

pub fn created_with_id(campaign_id: u64) -> Env {
    let mut env = setup_with_id(campaign_id);
    let ix = create_campaign_ix(&env, AMOUNT);
    send(&mut env.svm, ix, &env.admin).unwrap();
    env
}

pub fn campaign_pda(campaign_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[CAMPAIGN_SEED, &campaign_id.to_le_bytes()], &zkclaim::id()).0
}

pub fn eligible_pda(campaign: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[ELIGIBLE_SEED, campaign.as_ref(), wallet.as_ref()],
        &zkclaim::id(),
    )
    .0
}

pub fn registration_pda(campaign: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[REGISTRATION_SEED, campaign.as_ref(), wallet.as_ref()],
        &zkclaim::id(),
    )
    .0
}

/// Sends a single-instruction tx. Err carries the error and program logs.
pub fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) -> Result<(), String> {
    send_signed(svm, ix, payer, &[])
}

/// Like `send`, with extra signers beyond the fee payer.
pub fn send_signed(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair, others: &[&Keypair]) -> Result<(), String> {
    svm.expire_blockhash();
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let signers: Vec<&Keypair> = std::iter::once(payer).chain(others.iter().copied()).collect();
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &signers).unwrap();
    svm.send_transaction(tx)
        .map(|meta| println!("CU consumed: {}", meta.compute_units_consumed))
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

pub fn create_campaign_ix(env: &Env, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        zkclaim::id(),
        &zkclaim::instruction::CreateCampaign { campaign_id: env.campaign_id, amount }.data(),
        zkclaim::accounts::CreateCampaign {
            admin: env.admin.pubkey(),
            campaign: env.campaign,
            tree: env.tree,
            mint: env.mint,
            vault: env.vault,
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

pub fn add_eligible_ix(env: &Env, signer: &Pubkey, wallets: &[Pubkey], eligibles: &[Pubkey]) -> Instruction {
    let mut metas = zkclaim::accounts::AddEligible {
        admin: *signer,
        campaign: env.campaign,
        system_program: system_program::ID,
    }
    .to_account_metas(None);
    metas.extend(eligibles.iter().map(|e| AccountMeta::new(*e, false)));
    Instruction::new_with_bytes(
        zkclaim::id(),
        &zkclaim::instruction::AddEligible { wallets: wallets.to_vec() }.data(),
        metas,
    )
}

pub fn register_ix(env: &Env, user: &Pubkey, commitment: [u8; 32]) -> Instruction {
    register_with_payer_ix(env, user, user, commitment)
}

pub fn register_with_payer_ix(env: &Env, user: &Pubkey, payer: &Pubkey, commitment: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(
        zkclaim::id(),
        &zkclaim::instruction::Register { commitment }.data(),
        zkclaim::accounts::Register {
            user: *user,
            payer: *payer,
            campaign: env.campaign,
            tree: env.tree,
            eligible: eligible_pda(&env.campaign, user),
            registration: registration_pda(&env.campaign, user),
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// Allowlists a fresh funded wallet and returns it.
pub fn eligible_user(env: &mut Env) -> Keypair {
    let user = Keypair::new();
    env.svm.airdrop(&user.pubkey(), 100_000_000).unwrap();
    let ix = add_eligible_ix(
        env,
        &env.admin.pubkey(),
        &[user.pubkey()],
        &[eligible_pda(&env.campaign, &user.pubkey())],
    );
    send(&mut env.svm, ix, &env.admin).unwrap();
    user
}

pub fn freeze_campaign_ix(env: &Env, signer: &Pubkey) -> Instruction {
    Instruction::new_with_bytes(
        zkclaim::id(),
        &zkclaim::instruction::FreezeCampaign {}.data(),
        zkclaim::accounts::FreezeCampaign {
            admin: *signer,
            campaign: env.campaign,
            tree: env.tree,
        }
        .to_account_metas(None),
    )
}

pub fn nullifier_pda(campaign: &Pubkey, nullifier: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[NULLIFIER_SEED, campaign.as_ref(), nullifier], &zkclaim::id()).0
}

pub fn claim_ix(env: &Env, relayer: &Pubkey, recipient: &Pubkey, proof: [u8; 256], nullifier: [u8; 32]) -> Instruction {
    Instruction::new_with_bytes(
        zkclaim::id(),
        &zkclaim::instruction::Claim { proof, nullifier }.data(),
        zkclaim::accounts::Claim {
            relayer: *relayer,
            campaign: env.campaign,
            nullifier_account: nullifier_pda(&env.campaign, &nullifier),
            recipient: *recipient,
            recipient_token: get_associated_token_address(recipient, &env.mint),
            vault: env.vault,
            mint: env.mint,
            token_program: token::ID,
            associated_token_program: associated_token::ID,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
    )
}

/// ComputeBudget SetComputeUnitLimit, built by hand to avoid another dependency.
pub fn compute_limit_ix(units: u32) -> Instruction {
    let mut data = vec![2u8];
    data.extend_from_slice(&units.to_le_bytes());
    Instruction::new_with_bytes(COMPUTE_BUDGET_ID, &data, vec![])
}

pub const COMPUTE_BUDGET_ID: Pubkey =
    Pubkey::from_str_const("ComputeBudget111111111111111111111111111111");

/// Writes the vault's SPL balance directly (stands in for the admin's funding transfer).
pub fn fund_vault(env: &mut Env, amount: u64) {
    let acc = env.svm.get_account(&env.vault).unwrap();
    let mut state = spl_token::state::Account::unpack(&acc.data).unwrap();
    state.amount = amount;
    let mut data = acc.data.clone();
    spl_token::state::Account::pack(state, &mut data).unwrap();
    env.svm.set_account(env.vault, Account { data, ..acc }).unwrap();
}

pub fn token_balance(env: &Env, token_account: &Pubkey) -> u64 {
    let acc = env.svm.get_account(token_account).unwrap();
    spl_token::state::Account::unpack(&acc.data).unwrap().amount
}

pub fn from_hex32(s: &str) -> [u8; 32] {
    let s = s.trim_start_matches("0x");
    let mut out = [0u8; 32];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

/// Decimal field element (as in snarkjs JSON) -> 32-byte big-endian.
pub fn dec_to_be32(s: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    for digit in s.bytes() {
        let mut carry = (digit - b'0') as u32;
        for byte in out.iter_mut().rev() {
            let v = *byte as u32 * 10 + carry;
            *byte = v as u8;
            carry = v >> 8;
        }
        assert_eq!(carry, 0, "value exceeds 32 bytes");
    }
    out
}
