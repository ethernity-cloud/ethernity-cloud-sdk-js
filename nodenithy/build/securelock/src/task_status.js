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
    static IMPORT_ERROR = 28;
    // A required enclave config value is present but EMPTY (e.g. an ESR
    // address that was never baked into the sealed image). Reported eagerly
    // with the variable named, instead of a confusing downstream crash.
    static CONFIG_ERROR = 32;
    static EXECUTION_TIMEOUT = 33;      // Started but produced no result within the order duration.
    static ESR_GAS_LIMIT_EXCEEDED = 34; // ESR commits would exceed the per-order relayed-gas budget.
}

module.exports = {
    TaskStatus,
};
