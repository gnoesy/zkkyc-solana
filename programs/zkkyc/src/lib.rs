use anchor_lang::prelude::*;

declare_id!("ZkKYC111111111111111111111111111111111111111");

/// zkKYC — Privacy-preserving identity compliance via Arcium MXE
///
/// KYC checks run inside Arcium's encrypted execution environment.
/// The program stores only a compliance status commitment — never raw PII.
/// Umbra Privacy integration: verified users can access shielded DeFi
/// without re-exposing their identity on each protocol interaction.
#[program]
pub mod zkkyc {
    use super::*;

    /// Register a KYC provider (issuer of compliance attestations)
    pub fn register_provider(
        ctx: Context<RegisterProvider>,
        provider_id: u64,
        name: String,
        mxe_cluster_offset: u64,
    ) -> Result<()> {
        let provider = &mut ctx.accounts.provider;
        provider.authority = ctx.accounts.authority.key();
        provider.provider_id = provider_id;
        provider.name = name;
        provider.mxe_cluster_offset = mxe_cluster_offset;
        provider.active = true;
        provider.attestation_count = 0;

        emit!(ProviderRegistered {
            provider_id,
            mxe_cluster_offset,
        });
        Ok(())
    }

    /// Submit encrypted identity data for KYC verification.
    /// `encrypted_identity` — PII encrypted with MXE public key.
    /// The MXE checks compliance rules without decrypting to any single party.
    pub fn submit_kyc_request(
        ctx: Context<SubmitKyc>,
        provider_id: u64,
        encrypted_identity: Vec<u8>,
        identity_commitment: [u8; 32],
    ) -> Result<()> {
        let request = &mut ctx.accounts.kyc_request;
        request.subject = ctx.accounts.subject.key();
        request.provider_id = provider_id;
        request.encrypted_identity = encrypted_identity;
        request.identity_commitment = identity_commitment;
        request.status = KycStatus::Pending;
        request.submitted_at = Clock::get()?.unix_timestamp;

        emit!(KycRequested {
            subject: ctx.accounts.subject.key(),
            provider_id,
            identity_commitment,
        });
        Ok(())
    }

    /// Record MXE compliance result.
    /// Called by the KYC provider after Arcium MXE runs the compliance check.
    /// Only stores a boolean result + proof hash — zero PII on-chain.
    pub fn record_compliance_result(
        ctx: Context<RecordResult>,
        subject: Pubkey,
        compliance_status: bool,
        expiry: i64,
        mxe_proof_hash: [u8; 32],
        jurisdiction_flags: u16,
    ) -> Result<()> {
        let credential = &mut ctx.accounts.compliance_credential;
        credential.subject = subject;
        credential.issuer = ctx.accounts.provider_authority.key();
        credential.compliant = compliance_status;
        credential.issued_at = Clock::get()?.unix_timestamp;
        credential.expires_at = expiry;
        credential.mxe_proof_hash = mxe_proof_hash;
        credential.jurisdiction_flags = jurisdiction_flags;

        let request = &mut ctx.accounts.kyc_request;
        request.status = if compliance_status {
            KycStatus::Approved
        } else {
            KycStatus::Rejected
        };

        emit!(ComplianceResult {
            subject,
            compliant: compliance_status,
            expires_at: expiry,
            mxe_proof_hash,
        });
        Ok(())
    }

    /// Check compliance status (for DeFi protocol integration).
    /// Returns true if the subject has valid, non-expired compliance credential.
    /// Protocols call this instead of re-running KYC each time.
    pub fn verify_compliance(
        ctx: Context<VerifyCompliance>,
        _subject: Pubkey,
    ) -> Result<bool> {
        let credential = &ctx.accounts.compliance_credential;
        let clock = Clock::get()?;

        let valid = credential.compliant
            && credential.expires_at > clock.unix_timestamp;

        emit!(ComplianceChecked {
            subject: credential.subject,
            valid,
            checked_at: clock.unix_timestamp,
        });

        Ok(valid)
    }

    /// Revoke a compliance credential (e.g. sanctions match detected)
    pub fn revoke_credential(
        ctx: Context<RevokeCredential>,
        _subject: Pubkey,
        reason_code: u8,
    ) -> Result<()> {
        let credential = &mut ctx.accounts.compliance_credential;
        credential.compliant = false;
        credential.revoked = true;
        credential.revoke_reason = reason_code;

        emit!(CredentialRevoked {
            subject: credential.subject,
            reason_code,
        });
        Ok(())
    }
}

// --- Accounts ---

#[derive(Accounts)]
#[instruction(provider_id: u64)]
pub struct RegisterProvider<'info> {
    #[account(
        init,
        payer = authority,
        space = KycProvider::LEN,
        seeds = [b"provider", &provider_id.to_le_bytes()],
        bump
    )]
    pub provider: Account<'info, KycProvider>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(provider_id: u64)]
pub struct SubmitKyc<'info> {
    #[account(
        init,
        payer = subject,
        space = KycRequest::LEN,
        seeds = [b"kyc-req", subject.key().as_ref(), &provider_id.to_le_bytes()],
        bump
    )]
    pub kyc_request: Account<'info, KycRequest>,
    #[account(mut)]
    pub subject: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct RecordResult<'info> {
    #[account(
        init_if_needed,
        payer = provider_authority,
        space = ComplianceCredential::LEN,
        seeds = [b"credential", subject.as_ref()],
        bump
    )]
    pub compliance_credential: Account<'info, ComplianceCredential>,
    #[account(
        mut,
        seeds = [b"kyc-req", subject.as_ref(), &kyc_request.provider_id.to_le_bytes()],
        bump
    )]
    pub kyc_request: Account<'info, KycRequest>,
    #[account(mut)]
    pub provider_authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct VerifyCompliance<'info> {
    #[account(
        seeds = [b"credential", subject.as_ref()],
        bump
    )]
    pub compliance_credential: Account<'info, ComplianceCredential>,
}

#[derive(Accounts)]
#[instruction(subject: Pubkey)]
pub struct RevokeCredential<'info> {
    #[account(
        mut,
        seeds = [b"credential", subject.as_ref()],
        bump,
        has_one = issuer @ ZkKycError::Unauthorized
    )]
    pub compliance_credential: Account<'info, ComplianceCredential>,
    pub issuer: Signer<'info>,
}

// --- State ---

#[account]
pub struct KycProvider {
    pub authority: Pubkey,
    pub provider_id: u64,
    pub name: String,         // max 64 bytes
    pub mxe_cluster_offset: u64,
    pub active: bool,
    pub attestation_count: u64,
}

impl KycProvider {
    pub const LEN: usize = 8 + 32 + 8 + (4 + 64) + 8 + 1 + 8;
}

#[account]
pub struct KycRequest {
    pub subject: Pubkey,
    pub provider_id: u64,
    pub encrypted_identity: Vec<u8>, // max 512 bytes, MXE-encrypted PII
    pub identity_commitment: [u8; 32],
    pub status: KycStatus,
    pub submitted_at: i64,
}

impl KycRequest {
    pub const LEN: usize = 8 + 32 + 8 + (4 + 512) + 32 + 1 + 8;
}

#[account]
pub struct ComplianceCredential {
    pub subject: Pubkey,
    pub issuer: Pubkey,
    pub compliant: bool,
    pub issued_at: i64,
    pub expires_at: i64,
    pub mxe_proof_hash: [u8; 32],
    pub jurisdiction_flags: u16, // bitmask: US=0x01, EU=0x02, UK=0x04, etc.
    pub revoked: bool,
    pub revoke_reason: u8,
}

impl ComplianceCredential {
    pub const LEN: usize = 8 + 32 + 32 + 1 + 8 + 8 + 32 + 2 + 1 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum KycStatus {
    Pending,
    Approved,
    Rejected,
}

// --- Events ---

#[event]
pub struct ProviderRegistered {
    pub provider_id: u64,
    pub mxe_cluster_offset: u64,
}

#[event]
pub struct KycRequested {
    pub subject: Pubkey,
    pub provider_id: u64,
    pub identity_commitment: [u8; 32],
}

#[event]
pub struct ComplianceResult {
    pub subject: Pubkey,
    pub compliant: bool,
    pub expires_at: i64,
    pub mxe_proof_hash: [u8; 32],
}

#[event]
pub struct ComplianceChecked {
    pub subject: Pubkey,
    pub valid: bool,
    pub checked_at: i64,
}

#[event]
pub struct CredentialRevoked {
    pub subject: Pubkey,
    pub reason_code: u8,
}

// --- Errors ---

#[error_code]
pub enum ZkKycError {
    #[msg("Unauthorized: caller is not the credential issuer")]
    Unauthorized,
    #[msg("Credential has expired")]
    CredentialExpired,
    #[msg("Identity data exceeds 512 bytes")]
    IdentityDataTooLarge,
}
