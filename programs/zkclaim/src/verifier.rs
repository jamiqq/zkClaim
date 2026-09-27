use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

use crate::{
    error::ErrorCode,
    verifying_key::{NR_PUBLIC_INPUTS, VERIFYINGKEY},
};

/// Verifies a 256-byte proof (proof_a negated || proof_b || proof_c, big-endian) against
/// public inputs in circuit order. Same call as circuits/verifier-test/tests/verify.rs.
pub fn verify_proof(proof: &[u8; 256], inputs: &[[u8; 32]; NR_PUBLIC_INPUTS]) -> Result<()> {
    let a: &[u8; 64] = proof[0..64].try_into().unwrap();
    let b: &[u8; 128] = proof[64..192].try_into().unwrap();
    let c: &[u8; 64] = proof[192..256].try_into().unwrap();
    Groth16Verifier::new(a, b, c, inputs, &VERIFYINGKEY)
        .map_err(|_| error!(ErrorCode::ProofInvalid))?
        .verify()
        .map_err(|_| error!(ErrorCode::ProofInvalid))
}
