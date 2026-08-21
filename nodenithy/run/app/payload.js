// Minimal Ethernity Cloud payload. The `ecld` handle is injected into every
// run and reads like a contract object:
//   ecld.input          -> the request payload
//   ecld.caller         -> the data owner's wallet (msg.sender-style)
//   ecld.result(value)  -> return the task result
//   ecld.onInput = fn   -> (interactive sessions) handle each streamed input
// The legacy bare names (___etny_result___, ___etny_data_set___,
// ___etny_on_input___) still work, so existing payloads keep running.
function sum(a, b) {
    return a + b;
}
ecld.result(sum(1, 2).toString());
