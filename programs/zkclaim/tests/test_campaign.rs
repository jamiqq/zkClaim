use {
    anchor_lang::{
        prelude::Pubkey,
        solana_program::{
            instruction::{AccountMeta, Instruction},
            system_program,
        },
        AccountDeserialize, Discriminator, InstructionData, ToAccountMetas,
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
    zkclaim::{
        constants::{CAMPAIGN_SEED, ELIGIBLE_SEED, TREE_DEPTH, TREE_SEED, ZEROS},
        state::{Campaign, CampaignState, Eligible, Tree},
    },
};

const CAMPAIGN_ID: u64 = 42;
const AMOUNT: u64 = 1_000_000;

struct Env {
    svm: LiteSVM,
    admin: Keypair,
    mint: Pubkey,
    campaign: Pubkey,
    tree: Pubkey,
    vault: Pubkey,
}

fn setup() -> Env {
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

    let campaign = campaign_pda(CAMPAIGN_ID);
    let tree = Pubkey::find_program_address(&[TREE_SEED, campaign.as_ref()], &zkclaim::id()).0;
    let vault = get_associated_token_address(&campaign, &mint);

    Env { svm, admin, mint, campaign, tree, vault }
}

fn campaign_pda(campaign_id: u64) -> Pubkey {
    Pubkey::find_program_address(&[CAMPAIGN_SEED, &campaign_id.to_le_bytes()], &zkclaim::id()).0
}

fn eligible_pda(campaign: &Pubkey, wallet: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(
        &[ELIGIBLE_SEED, campaign.as_ref(), wallet.as_ref()],
        &zkclaim::id(),
    )
    .0
}

fn send(svm: &mut LiteSVM, ix: Instruction, payer: &Keypair) -> Result<(), String> {
    let blockhash = svm.latest_blockhash();
    let msg = Message::new_with_blockhash(&[ix], Some(&payer.pubkey()), &blockhash);
    let tx = VersionedTransaction::try_new(VersionedMessage::Legacy(msg), &[payer]).unwrap();
    svm.send_transaction(tx)
        .map(|meta| println!("CU consumed: {}", meta.compute_units_consumed))
        .map_err(|e| format!("{:?}\n{}", e.err, e.meta.logs.join("\n")))
}

fn create_campaign_ix(env: &Env, amount: u64) -> Instruction {
    Instruction::new_with_bytes(
        zkclaim::id(),
        &zkclaim::instruction::CreateCampaign { campaign_id: CAMPAIGN_ID, amount }.data(),
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

fn add_eligible_ix(env: &Env, signer: &Pubkey, wallets: &[Pubkey], eligibles: &[Pubkey]) -> Instruction {
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

fn created() -> Env {
    let mut env = setup();
    let ix = create_campaign_ix(&env, AMOUNT);
    send(&mut env.svm, ix, &env.admin).unwrap();
    env
}

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
    env.svm.expire_blockhash();
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
    env.svm.expire_blockhash();
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
