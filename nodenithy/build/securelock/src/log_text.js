'use strict';
// What the securelock logs in place of a value that can hold the data
// owner's data. Its stdout and stderr reach the node's container log, which
// the operator reads: a thrown value's message, stack or text can quote the
// payload, the input or what they computed, and a result is the data
// owner's. Neither is logged.

const crypto = require('crypto');

// The name of a thrown value's class (the name of its prototype's
// constructor) for an object or a function, the type of any other value.
function errorClass(value) {
    if (value === null) return 'null';
    if (typeof value !== 'object' && typeof value !== 'function') return typeof value;
    try {
        const proto = Object.getPrototypeOf(value);
        const ctor = proto === null ? null : proto.constructor;
        if (typeof ctor === 'function' && typeof ctor.name === 'string' && ctor.name) return ctor.name;
    } catch (e) {
        // A proxy's trap or a getter of the prototype threw: the type is logged.
    }
    return typeof value;
}

// A result as the securelock logs it: the length in UTF-8 bytes and the
// SHA-256 in hex of the text String() gives it, 'not text' for a value
// String() throws on.
function resultDigest(result) {
    let text;
    try {
        text = String(result);
    } catch (e) {
        return 'not text';
    }
    return `${Buffer.byteLength(text, 'utf8')} bytes, sha256 ${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

module.exports = { errorClass, resultDigest };
