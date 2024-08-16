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
}

module.exports = {
    TaskStatus,
};
