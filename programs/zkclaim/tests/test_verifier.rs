use zkclaim::verifier::verify_proof;

/// P1 fixture: snarkjs proof converted to the groth16-solana layout (campaign_id = 1).
fn fixture() -> ([u8; 256], [[u8; 32]; 5]) {
    let v: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/proof_solana.json")).unwrap();
    let hex = |s: &str| -> Vec<u8> {
        (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i + 2], 16).unwrap()).collect()
    };
    let proof: [u8; 256] = hex(v["proof"].as_str().unwrap()).try_into().unwrap();
    let mut inputs = [[0u8; 32]; 5];
    for (i, h) in v["public_inputs"].as_array().unwrap().iter().enumerate() {
        inputs[i] = hex(h.as_str().unwrap()).try_into().unwrap();
    }
    (proof, inputs)
}

#[test]
fn fixture_proof_verifies() {
    let (proof, inputs) = fixture();
    assert!(verify_proof(&proof, &inputs).is_ok());
}

#[test]
fn any_flipped_proof_byte_fails() {
    let (proof, inputs) = fixture();
    // One byte in each of proof_a, proof_b, proof_c.
    for i in [31, 63, 100, 191, 223, 255] {
        let mut bad = proof;
        bad[i] ^= 1;
        assert!(verify_proof(&bad, &inputs).is_err(), "byte {i}");
    }
}

#[test]
fn any_flipped_public_input_fails() {
    let (proof, inputs) = fixture();
    for i in 0..5 {
        let mut bad = inputs;
        bad[i][31] ^= 1;
        assert!(verify_proof(&proof, &bad).is_err(), "input {i}");
    }
}
