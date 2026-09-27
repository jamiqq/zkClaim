/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/zkclaim.json`.
 */
export type Zkclaim = {
  "address": "EHsj9Fz1QuPB9drLUF9SPk63y23pXcSXzfr65MjD3nT3",
  "metadata": {
    "name": "zkclaim",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "addEligible",
      "discriminator": [
        181,
        45,
        41,
        132,
        148,
        165,
        2,
        11
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "campaign"
          ]
        },
        {
          "name": "campaign"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wallets",
          "type": {
            "vec": "pubkey"
          }
        }
      ]
    },
    {
      "name": "createCampaign",
      "discriminator": [
        111,
        131,
        187,
        98,
        160,
        193,
        114,
        244
      ],
      "accounts": [
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "campaign",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  97,
                  109,
                  112,
                  97,
                  105,
                  103,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "campaignId"
              }
            ]
          }
        },
        {
          "name": "tree",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              }
            ]
          }
        },
        {
          "name": "mint"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "campaign"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "campaignId",
          "type": "u64"
        },
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "freezeCampaign",
      "discriminator": [
        165,
        89,
        137,
        206,
        78,
        240,
        248,
        118
      ],
      "accounts": [
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "campaign"
          ]
        },
        {
          "name": "campaign",
          "writable": true
        },
        {
          "name": "tree",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "increment",
      "discriminator": [
        11,
        18,
        104,
        9,
        104,
        174,
        59,
        33
      ],
      "accounts": [
        {
          "name": "counter",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  117,
                  110,
                  116,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "authority",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "counter",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  117,
                  110,
                  116,
                  101,
                  114
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "register",
      "discriminator": [
        211,
        124,
        67,
        15,
        211,
        194,
        178,
        240
      ],
      "accounts": [
        {
          "name": "user",
          "docs": [
            "The allowlisted wallet. Signs, but needs no SOL."
          ],
          "signer": true
        },
        {
          "name": "payer",
          "docs": [
            "Pays rent for `registration` and receives `eligible`'s rent. Web users pass themselves;",
            "seed scripts pass a sponsor."
          ],
          "writable": true,
          "signer": true
        },
        {
          "name": "campaign"
        },
        {
          "name": "tree",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              }
            ]
          }
        },
        {
          "name": "eligible",
          "docs": [
            "Missing account = wallet not allowlisted (or already registered)."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  108,
                  105,
                  103,
                  105,
                  98,
                  108,
                  101
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "registration",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  103,
                  105,
                  115,
                  116,
                  114,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "campaign"
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "commitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "campaign",
      "discriminator": [
        50,
        40,
        49,
        11,
        157,
        220,
        229,
        192
      ]
    },
    {
      "name": "counter",
      "discriminator": [
        255,
        176,
        4,
        245,
        188,
        253,
        124,
        25
      ]
    },
    {
      "name": "eligible",
      "discriminator": [
        97,
        73,
        112,
        226,
        163,
        157,
        171,
        191
      ]
    },
    {
      "name": "registration",
      "discriminator": [
        158,
        129,
        230,
        90,
        93,
        95,
        101,
        55
      ]
    },
    {
      "name": "tree",
      "discriminator": [
        100,
        9,
        213,
        154,
        6,
        136,
        109,
        55
      ]
    }
  ],
  "events": [
    {
      "name": "campaignFrozen",
      "discriminator": [
        150,
        144,
        204,
        113,
        201,
        229,
        191,
        200
      ]
    },
    {
      "name": "registered",
      "discriminator": [
        11,
        222,
        10,
        72,
        160,
        110,
        165,
        227
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "unauthorized",
      "msg": "Signer is not authorized for this action"
    },
    {
      "code": 6001,
      "name": "counterOverflow",
      "msg": "Counter has reached the maximum value"
    },
    {
      "code": 6002,
      "name": "notRegistering",
      "msg": "Campaign is not in the Registering state"
    },
    {
      "code": 6003,
      "name": "notFrozen",
      "msg": "Campaign is not in the Frozen state"
    },
    {
      "code": 6004,
      "name": "treeFull",
      "msg": "Merkle tree is full"
    },
    {
      "code": 6005,
      "name": "invalidCommitment",
      "msg": "Commitment must be non-zero and below the BN254 modulus"
    },
    {
      "code": 6006,
      "name": "invalidNullifier",
      "msg": "Nullifier must be below the BN254 modulus"
    },
    {
      "code": 6007,
      "name": "proofInvalid",
      "msg": "Groth16 proof verification failed"
    },
    {
      "code": 6008,
      "name": "invalidAmount",
      "msg": "Claim amount must be greater than zero"
    },
    {
      "code": 6009,
      "name": "eligibleCountMismatch",
      "msg": "Wallet list must be non-empty and match the remaining accounts one-to-one"
    },
    {
      "code": 6010,
      "name": "invalidEligibleAccount",
      "msg": "Remaining account is not the Eligible PDA for this campaign and wallet"
    },
    {
      "code": 6011,
      "name": "alreadyEligible",
      "msg": "Wallet is already eligible for this campaign"
    },
    {
      "code": 6012,
      "name": "poseidonFailed",
      "msg": "Poseidon hash syscall failed"
    },
    {
      "code": 6013,
      "name": "noRegistrations",
      "msg": "Cannot freeze a campaign with no registrations"
    }
  ],
  "types": [
    {
      "name": "campaign",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "campaignId",
            "type": "u64"
          },
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "vault",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          },
          {
            "name": "state",
            "type": {
              "defined": {
                "name": "campaignState"
              }
            }
          },
          {
            "name": "root",
            "docs": [
              "Locked by `freeze` from `tree.current_root`; zero while registering."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "campaignFrozen",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "campaign",
            "type": "pubkey"
          },
          {
            "name": "root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "registrations",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "campaignState",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "registering"
          },
          {
            "name": "frozen"
          }
        ]
      }
    },
    {
      "name": "counter",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "count",
            "type": "u64"
          },
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "eligible",
      "docs": [
        "Empty marker: its existence at [\"eligible\", campaign, wallet] means the wallet may register once."
      ],
      "type": {
        "kind": "struct",
        "fields": []
      }
    },
    {
      "name": "registered",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "index",
            "type": "u32"
          },
          {
            "name": "commitment",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "root",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "registration",
      "docs": [
        "Permanent marker at [\"registration\", campaign, wallet]: survives the `Eligible` close,",
        "so a wallet can never register twice even if the admin re-adds it."
      ],
      "type": {
        "kind": "struct",
        "fields": []
      }
    },
    {
      "name": "tree",
      "docs": [
        "Incremental Merkle tree (Tornado-style). Zero-copy: ~8.5 KB would blow the stack via Borsh."
      ],
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "filledSubtrees",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                8
              ]
            }
          },
          {
            "name": "currentRoot",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "leaves",
            "type": {
              "array": [
                {
                  "array": [
                    "u8",
                    32
                  ]
                },
                256
              ]
            }
          },
          {
            "name": "nextIndex",
            "type": "u32"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "campaignSeed",
      "type": "bytes",
      "value": "[99, 97, 109, 112, 97, 105, 103, 110]"
    },
    {
      "name": "counterSeed",
      "type": "bytes",
      "value": "[99, 111, 117, 110, 116, 101, 114]"
    },
    {
      "name": "eligibleSeed",
      "type": "bytes",
      "value": "[101, 108, 105, 103, 105, 98, 108, 101]"
    },
    {
      "name": "helloWorldLamports",
      "type": "u64",
      "value": "1"
    },
    {
      "name": "maxCount",
      "type": "u64",
      "value": "10"
    },
    {
      "name": "nullifierSeed",
      "type": "bytes",
      "value": "[110, 117, 108, 108, 105, 102, 105, 101, 114]"
    },
    {
      "name": "registrationSeed",
      "type": "bytes",
      "value": "[114, 101, 103, 105, 115, 116, 114, 97, 116, 105, 111, 110]"
    },
    {
      "name": "treeSeed",
      "type": "bytes",
      "value": "[116, 114, 101, 101]"
    }
  ]
};
