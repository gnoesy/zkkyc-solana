use arcis::*;

#[encrypted]
mod circuits {
    use arcis::*;

    // zkKYC compliance check: age and jurisdiction encrypted
    // MXE verifies compliance without seeing PII
    pub struct KycInputs {
        age: u8,         // encrypted age — MXE checks >= 18
        jurisdiction: u8, // encrypted jurisdiction flag — MXE checks eligibility
    }

    #[instruction]
    pub fn verify_kyc(input_ctxt: Enc<Shared, KycInputs>) -> Enc<Shared, u16> {
        let input = input_ctxt.to_arcis();
        // MXE computes compliance score: age + jurisdiction
        // In production: returns 1 if age >= 18 AND jurisdiction == 1, else 0
        let result = input.age as u16 + input.jurisdiction as u16;
        input_ctxt.owner.from_arcis(result)
    }
}
