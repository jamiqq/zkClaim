pragma circom 2.1.6;
include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/mux1.circom";

template MerkleProof(depth) {
    signal input leaf;
    signal input pathElements[depth];
    signal input pathIndices[depth];   // 0 = current node is left child
    signal output root;

    signal levels[depth + 1];
    component mux[depth];
    component h[depth];
    levels[0] <== leaf;

    for (var i = 0; i < depth; i++) {
        pathIndices[i] * (1 - pathIndices[i]) === 0;
        mux[i] = MultiMux1(2);
        mux[i].c[0][0] <== levels[i];
        mux[i].c[0][1] <== pathElements[i];
        mux[i].c[1][0] <== pathElements[i];
        mux[i].c[1][1] <== levels[i];
        mux[i].s <== pathIndices[i];
        h[i] = Poseidon(2);
        h[i].inputs[0] <== mux[i].out[0];
        h[i].inputs[1] <== mux[i].out[1];
        levels[i + 1] <== h[i].out;
    }
    root <== levels[depth];
}

template ZkClaim(depth) {
    // public: declared in the interface-contract order
    signal input root;
    signal input nullifier;
    signal input recipient_hi;
    signal input recipient_lo;
    signal input campaign_id;
    // private
    signal input secret;
    signal input pathElements[depth];
    signal input pathIndices[depth];

    component leafHash = Poseidon(1);
    leafHash.inputs[0] <== secret;

    component mp = MerkleProof(depth);
    mp.leaf <== leafHash.out;
    for (var i = 0; i < depth; i++) {
        mp.pathElements[i] <== pathElements[i];
        mp.pathIndices[i] <== pathIndices[i];
    }
    mp.root === root;

    component nh = Poseidon(2);
    nh.inputs[0] <== secret;
    nh.inputs[1] <== campaign_id;
    nh.out === nullifier;

    // range checks bind the recipient limbs; the square is the Tornado-style extra binding
    component hiBits = Num2Bits(128);
    hiBits.in <== recipient_hi;
    component loBits = Num2Bits(128);
    loBits.in <== recipient_lo;
    signal recipientSq;
    recipientSq <== (recipient_hi + recipient_lo) * (recipient_hi + recipient_lo);
}

component main {public [root, nullifier, recipient_hi, recipient_lo, campaign_id]} = ZkClaim(8);