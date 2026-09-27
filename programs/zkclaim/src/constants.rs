use anchor_lang::prelude::*;

#[constant]
pub const COUNTER_SEED: &[u8] = b"counter";

#[constant]
pub const HELLO_WORLD_LAMPORTS: u64 = 1;

#[constant]
pub const MAX_COUNT: u64 = 10;

#[constant]
pub const CAMPAIGN_SEED: &[u8] = b"campaign";

#[constant]
pub const TREE_SEED: &[u8] = b"tree";

#[constant]
pub const ELIGIBLE_SEED: &[u8] = b"eligible";

#[constant]
pub const REGISTRATION_SEED: &[u8] = b"registration";

#[constant]
pub const NULLIFIER_SEED: &[u8] = b"nullifier";

pub const TREE_DEPTH: usize = 8;

pub const MAX_LEAVES: usize = 1 << TREE_DEPTH;

/// Empty-subtree hashes, 32-byte big-endian: zero[0] = 0, zero[i+1] = Poseidon(zero[i], zero[i]).
/// Must match shared/test-vectors.json and the circuit. zero[TREE_DEPTH] is the empty root.
pub const ZEROS: [[u8; 32]; TREE_DEPTH + 1] = [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [32, 152, 245, 251, 158, 35, 158, 171, 60, 234, 195, 242, 123, 129, 228, 129, 220, 49, 36, 213, 95, 254, 213, 35, 168, 57, 238, 132, 70, 182, 72, 100],
    [16, 105, 103, 61, 205, 177, 34, 99, 223, 48, 26, 111, 245, 132, 167, 236, 38, 26, 68, 203, 157, 198, 141, 240, 103, 164, 119, 68, 96, 177, 241, 225],
    [24, 244, 51, 49, 83, 126, 226, 175, 46, 61, 117, 141, 80, 247, 33, 6, 70, 124, 110, 234, 80, 55, 29, 213, 40, 213, 126, 178, 184, 86, 210, 56],
    [7, 249, 216, 55, 203, 23, 176, 211, 99, 32, 255, 233, 59, 165, 35, 69, 241, 183, 40, 87, 26, 86, 130, 101, 202, 172, 151, 85, 157, 188, 149, 42],
    [43, 148, 207, 94, 135, 70, 179, 245, 201, 99, 31, 76, 93, 243, 41, 7, 166, 153, 197, 140, 148, 178, 173, 77, 123, 92, 236, 22, 57, 24, 63, 85],
    [45, 238, 147, 197, 166, 102, 69, 150, 70, 234, 125, 34, 204, 169, 225, 188, 254, 215, 30, 105, 81, 185, 83, 97, 29, 17, 221, 163, 46, 160, 157, 120],
    [7, 130, 149, 229, 162, 43, 132, 233, 130, 207, 96, 30, 182, 57, 89, 123, 139, 5, 21, 168, 140, 181, 172, 127, 168, 164, 170, 190, 60, 135, 52, 157],
    [47, 165, 229, 241, 143, 96, 39, 166, 80, 27, 236, 134, 69, 100, 71, 42, 97, 107, 46, 39, 74, 65, 33, 26, 68, 76, 190, 58, 153, 243, 204, 97],
];

/// BN254 scalar field modulus, 32-byte big-endian. Field elements must be strictly below it.
pub const FIELD_MODULUS_BE: [u8; 32] = [
    48, 100, 78, 114, 225, 49, 160, 41, 184, 80, 69, 182, 129, 129, 88, 93, 40, 51, 232, 72, 121,
    185, 112, 145, 67, 225, 245, 147, 240, 0, 0, 1,
];
