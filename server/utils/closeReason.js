const MAX_CLOSE_REASON_BYTES = 123;

module.exports.closeReason = (reason) => {
    const text = String(reason ?? "");
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= MAX_CLOSE_REASON_BYTES) return text;
    let end = MAX_CLOSE_REASON_BYTES;
    while (end > 0 && (bytes[end] & 0xC0) === 0x80) end--;
    return bytes.subarray(0, end).toString("utf8");
};
