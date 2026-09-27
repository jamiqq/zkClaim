use groth16_solana::groth16::Groth16Verifier;
use zkclaim_verifier_test::verifying_key::VERIFYINGKEY;

fn load() -> ([u8; 256], [[u8; 32]; 5]) {
    let raw = std::fs::read_to_string("../build/proof_solana.json").expect("run scripts/export-solana.js first");
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
    let proof: [u8; 256] = hex::decode(v["proof"].as_str().unwrap()).unwrap().try_into().unwrap();
    let mut inputs = [[0u8; 32]; 5];
    for (i, h) in v["public_inputs"].as_array().unwrap().iter().enumerate() {
        inputs[i] = hex::decode(h.as_str().unwrap()).unwrap().try_into().unwrap();
    }
    (proof, inputs)
}

fn verify(proof: &[u8; 256], inputs: &[[u8; 32]; 5]) -> bool {
    let a: [u8; 64] = proof[0..64].try_into().unwrap();
    let b: [u8; 128] = proof[64..192].try_into().unwrap();
    let c: [u8; 64] = proof[192..256].try_into().unwrap();
    match Groth16Verifier::new(&a, &b, &c, inputs, &VERIFYINGKEY) {
        Ok(mut v) => v.verify().is_ok(),
        Err(_) => false,
    }
}

#[test]
fn valid_proof_verifies() {
    let (proof, inputs) = load();
    assert!(verify(&proof, &inputs));
}

#[test]
fn swapped_recipient_fails() {
    let (proof, mut inputs) = load();
    inputs[3][31] ^= 1; // recipient_lo
    assert!(!verify(&proof, &inputs));
}

#[test]
fn other_nullifier_fails() {
    let (proof, mut inputs) = load();
    inputs[1][31] ^= 1;
    assert!(!verify(&proof, &inputs));
}

#[test]
fn other_campaign_fails() {
    let (proof, mut inputs) = load();
    inputs[4][31] ^= 1;
    assert!(!verify(&proof, &inputs));
}

#[test]
fn tampered_proof_fails() {
    let (mut proof, inputs) = load();
    proof[200] ^= 1;
    assert!(!verify(&proof, &inputs));
}
