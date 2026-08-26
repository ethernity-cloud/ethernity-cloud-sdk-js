class TaskStatus {
    static SUCCESS = 0;
    static SYSTEM_ERROR = 1;
    static KEY_ERROR = 2;
    static SYNTAX_WARNING = 3;
    static BASE_EXCEPTION = 4;
    static PAYLOAD_NOT_DEFINED = 5;
    static PAYLOAD_CHECKSUM_ERROR = 6;
    static INPUT_CHECKSUM_ERROR = 7;
    static EVAL_ERROR = 8;
    // Extended diagnostic (matches the trustedzone's extended enum): the
    // serverless backend failed to load, so none of its functions exist.
    static SIGNATURE_ERROR = 20;        // Trustedzone handover signature failed to verify.
    static IMPORT_ERROR = 28;
    // A required enclave config value is present but EMPTY (e.g. an ESR
    // address that was never baked into the sealed image). Reported eagerly
    // with the variable named, instead of a confusing downstream crash.
    static CONFIG_ERROR = 32;
    static EXECUTION_TIMEOUT = 33;      // Started but produced no result within the order duration.
    static ESR_GAS_LIMIT_EXCEEDED = 34; // ESR commits would exceed the per-order relayed-gas budget.
    static SECURITY_VIOLATION = 35;     // A state commit was authorized under a caller other than
    static ESR_NONCE_VIOLATION = 36;    // A commit's idempotency nonce was already used -- duplicate
    // The enclave signed state commits but they did not land on the registry
    // within 5 blocks -- the node did not relay them. The validator REFUNDS.
    static ESR_RELAY_TIMEOUT = 37;
    // More than 100 state commits in one run -- the per-run cap that bounds
    // relayed transactions and the result size. dApp-side fault: NO refund.
    static ESR_COMMIT_LIMIT_EXCEEDED = 38;
                                        // suppressed, state unchanged (StateNonceError).
                                        // the task's submitter (the in-enclave ownership check was
                                        // bypassed). Set by the securelock on a detected forged
                                        // caller, and by the trustedzone re-adjudication.
    // The CAS that provisioned this enclave presented an INVALID
    // self-attestation quote (ECAS_CAS_QUOTE failing the ValidatorRegistry
    // checks). A missing quote is a rollout gap and only logs; an INCORRECT
    // one means the operator provisioned the task through an impostor CAS.
    // Operator fault; the order terminates and the validator REFUNDS it.
    static CAS_ATTESTATION_FAULT = 40;
}

module.exports = {
    TaskStatus,
};
