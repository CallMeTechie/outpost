const OPCODE_FRAME = 0x01;
const HEADER_LENGTH = 5;

const encodeFrame = (seq, jpeg) => {
    const frame = Buffer.allocUnsafe(HEADER_LENGTH + jpeg.length);
    frame[0] = OPCODE_FRAME;
    frame.writeUInt32BE(seq >>> 0, 1);
    jpeg.copy(frame, HEADER_LENGTH);
    return frame;
};

const nextSeq = (seq) => (seq + 1) >>> 0;

module.exports = { OPCODE_FRAME, encodeFrame, nextSeq };
