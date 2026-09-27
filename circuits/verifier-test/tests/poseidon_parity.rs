// Solana's Poseidon (same implementation as the on-chain syscall, run natively)
// must match circomlibjs byte for byte. Vectors: shared/test-vectors.json.
use solana_poseidon::{hashv, Endianness, Parameters};

fn h(inputs: &[&[u8; 32]]) -> [u8; 32] {
    let slices: Vec<&[u8]> = inputs.iter().map(|x| &x[..]).collect();
    hashv(Parameters::Bn254X5, Endianness::BigEndian, &slices).unwrap().to_bytes()
}

fn from_hex(s: &str) -> [u8; 32] {
    hex::decode(s).unwrap().try_into().unwrap()
}

#[test]
fn matches_circomlibjs() {
    let raw = std::fs::read_to_string("../../shared/test-vectors.json").unwrap();
    let v: serde_json::Value = serde_json::from_str(&raw).unwrap();

    let mut one = [0u8; 32]; one[31] = 1;
    let mut two = [0u8; 32]; two[31] = 2;
    assert_eq!(h(&[&one]), from_hex(v["poseidon(1)"]["hex"].as_str().unwrap()));
    assert_eq!(h(&[&one, &two]), from_hex(v["poseidon(1,2)"]["hex"].as_str().unwrap()));

    let mut z = [0u8; 32];
    for i in 0..8 {
        z = h(&[&z, &z]);
        assert_eq!(z, from_hex(v["zeros"][i + 1]["hex"].as_str().unwrap()), "zero[{}]", i + 1);
    }
}
