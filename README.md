# zkKYC — Privacy-Preserving Identity Compliance on Solana

> KYC checks run inside Arcium MXE. The program stores only a compliance boolean — never raw PII. Integrates with Umbra for private DeFi access.

[![Solana Devnet](https://img.shields.io/badge/Solana-devnet-9945FF)](https://explorer.solana.com/?cluster=devnet)
[![Arcium MXE](https://img.shields.io/badge/Arcium-MXE%20cluster%20456-00D4FF)](https://arcium.com)
[![Anchor](https://img.shields.io/badge/Anchor-0.32.1-orange)](https://anchor-lang.com)

**Program ID (devnet):** `Eyn3GkHCZkPFTr3yhbUwxgpmfwSBf6mfMvj76TeUSG2h`
[View on Explorer](https://explorer.solana.com/address/Eyn3GkHCZkPFTr3yhbUwxgpmfwSBf6mfMvj76TeUSG2h?cluster=devnet)

---

## Problem

KYC/AML compliance in DeFi requires identity verification, but storing PII on-chain creates:

- Permanent public exposure of personal data
- Correlation risk across wallets
- GDPR/compliance liability for protocol operators
- Single-point-of-failure for identity data

Existing solutions either skip compliance entirely or require fully centralized identity providers.

---

## Architecture

```
User submits KYC request
  │
  ├─ Encrypt PII with MXE public key (x25519-RescueCipher)
  │    Name, DOB, document hash — never lands on-chain unencrypted
  │
  └─► Solana Program (zkkyc)
        │  store encrypted_identity + identity_commitment
        │
        └─► Arcium MXE (cluster offset: 456)
              │  run compliance rules on encrypted data
              │  check sanctions lists, AML patterns
              │  produce compliance_result + proof_hash
              │
              └─► Solana (record_compliance_result)
                    │  store: compliant=true/false, expires_at, mxe_proof_hash
                    └─ zero PII stored on-chain

DeFi Protocol integration:
  protocol.verify_compliance(userPubkey) → true/false
  ↓
  User accesses protocol without re-verifying identity
```

**Umbra integration:** Compliant users access Umbra shielded pools using their credential. Protocol verifies compliance without knowing which addresses belong to the user.

---

## On-chain Instructions

| Instruction | Description |
|---|---|
| `register_provider` | Register KYC issuer with MXE routing config |
| `submit_kyc_request` | Submit MXE-encrypted identity for compliance check |
| `record_compliance_result` | Write MXE result (boolean + proof hash) on-chain |
| `verify_compliance` | DeFi protocols call this to gate access |
| `revoke_credential` | Revoke on sanctions match / expiry |

---

## What Is Never On-Chain

- Name, date of birth, document numbers
- Facial biometric data
- Address or phone number
- Any raw PII

## What Is On-Chain

- `compliant: bool`
- `expires_at: i64` (Unix timestamp)
- `mxe_proof_hash: [u8; 32]` (Arcium MXE result commitment)
- `jurisdiction_flags: u16` (bitmask for US/EU/UK compliance)

---

## Umbra × zkKYC: Private DeFi Access

Traditional flow: User reveals identity → Protocol stores record → Data leak risk

zkKYC + Umbra flow:
1. User completes KYC once → `compliant=true` stored on-chain (no PII)
2. User deposits to Umbra shielded pool
3. User generates stealth address from Umbra
4. DeFi protocol calls `verify_compliance(stealthAddress)` → true
5. Protocol grants access with zero wallet-to-identity correlation

---

## Devnet Activity

- **Wallet:** `4Y8R73V9QpmL2oUtS4LrwdZk3LrPRCLp7KGg2npPkB1u`
- **Arcium MXE cluster offset:** 456
- **Network:** Solana devnet

---

## Program Structure

```
programs/zkkyc/src/lib.rs         — Anchor program (Rust)
tests/zkkyc.ts                    — Integration tests
scripts/arcium_interaction.js     — Devnet activity scripts
evidence/                         — On-chain activity logs
```

---

## Tech Stack

- Solana + Anchor 0.32.1
- Arcium MXE (x25519 + RescueCipher)
- Umbra Privacy SDK (shielded pool integration)

---

## Status

- [x] Program design + Rust implementation
- [x] Devnet deployment target (cluster 456)
- [x] Umbra integration architecture
- [ ] Sanctions list integration via Arcium MXE
- [ ] Mainnet deployment

---

*zkKYC explores privacy-preserving compliance infrastructure for Solana DeFi.*
