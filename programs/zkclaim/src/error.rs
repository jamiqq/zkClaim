use anchor_lang::prelude::*;

#[error_code]
pub enum ErrorCode {
    #[msg("Signer is not authorized for this action")]
    Unauthorized,
    #[msg("Campaign is not in the Registering state")]
    NotRegistering,
    #[msg("Campaign is not in the Frozen state")]
    NotFrozen,
    #[msg("Merkle tree is full")]
    TreeFull,
    #[msg("Commitment must be non-zero and below the BN254 modulus")]
    InvalidCommitment,
    #[msg("Nullifier must be below the BN254 modulus")]
    InvalidNullifier,
    #[msg("Groth16 proof verification failed")]
    ProofInvalid,
    #[msg("Claim amount must be greater than zero")]
    InvalidAmount,
    #[msg("Wallet list must be non-empty and match the remaining accounts one-to-one")]
    EligibleCountMismatch,
    #[msg("Remaining account is not the Eligible PDA for this campaign and wallet")]
    InvalidEligibleAccount,
    #[msg("Wallet is already eligible for this campaign")]
    AlreadyEligible,
    #[msg("Poseidon hash syscall failed")]
    PoseidonFailed,
    #[msg("Cannot freeze a campaign with no registrations")]
    NoRegistrations,
}
