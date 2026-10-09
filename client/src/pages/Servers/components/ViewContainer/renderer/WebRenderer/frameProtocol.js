const OPCODE_FRAME = 0x01;
const HEADER_LENGTH = 5;

export const decodeFrame = (input) => {
    if (!(input instanceof ArrayBuffer) && !ArrayBuffer.isView(input)) return null;
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    if (bytes.length < HEADER_LENGTH || bytes[0] !== OPCODE_FRAME) return null;
    const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(1, false);
    return { seq, data: bytes.subarray(HEADER_LENGTH) };
};

// Sequence numbers wrap at 2^32; "newer" means less than half the ring ahead.
export const isNewerSeq = (candidate, current) =>
    current === null || (candidate !== current && ((candidate - current) >>> 0) < 0x80000000);
