const test = require("node:test");
const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const flatbuffers = require("flatbuffers");
const EngineSftpClient = require("../EngineSftpClient");
const { SftpMsgType, SftpMessage, FileDataRes } = require("../generated/sftp_protocol_generated");

// A real PassThrough stands in for the control-plane socket, not a stub: pause() and resume() only
// mean something with genuine stream semantics behind them — a stub could not show that a paused
// socket actually stops delivering frames, which is the entire point of the change.
const createClient = () => {
    const socket = new PassThrough();
    const client = new EngineSftpClient(socket);
    // Nothing may be written back into the same stream — a request frame would come straight back
    // in as if the engine had sent it.
    client._buildAndSend = () => {};

    // Installed after the constructor, so the resume() that on("data") performs internally when it
    // switches the socket to flowing mode is not counted as one of ours.
    const events = [];
    const pause = socket.pause.bind(socket);
    const resume = socket.resume.bind(socket);
    socket.pause = () => { events.push("pause"); return pause(); };
    socket.resume = () => { events.push("resume"); return resume(); };

    return { client, socket, events };
};

const RID = 1;
const tick = () => new Promise((r) => setImmediate(r));

const framed = (payload) => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, Buffer.from(payload)]);
};

const dataFrame = (rid, data, totalSize) => {
    const b = new flatbuffers.Builder(data.length + 256);
    const dataOff = FileDataRes.createDataVector(b, data);
    FileDataRes.startFileDataRes(b);
    FileDataRes.addData(b, dataOff);
    FileDataRes.addTotalSize(b, BigInt(totalSize));
    const resOff = FileDataRes.endFileDataRes(b);

    SftpMessage.startSftpMessage(b);
    SftpMessage.addMsgType(b, SftpMsgType.FileData);
    SftpMessage.addRequestId(b, rid);
    SftpMessage.addFileDataRes(b, resOff);
    SftpMessage.finishSftpMessageBuffer(b, SftpMessage.endSftpMessage(b));
    return framed(b.asUint8Array());
};

const endFrame = (rid) => {
    const b = new flatbuffers.Builder(64);
    SftpMessage.startSftpMessage(b);
    SftpMessage.addMsgType(b, SftpMsgType.FileEnd);
    SftpMessage.addRequestId(b, rid);
    SftpMessage.finishSftpMessageBuffer(b, SftpMessage.endSftpMessage(b));
    return framed(b.asUint8Array());
};

const CHUNK = 64 * 1024;
const payload = Buffer.alloc(CHUNK, 7);

// (a) The point of the whole exercise: a consumer slower than the source must not make the buffer
// grow with the rate difference. The socket has to go down and come back up again for that.
test("a backpressured read pauses the socket for a slow consumer and keeps the buffer small", async () => {
    const { client, socket, events } = createClient();
    const { stream, done } = client.readFile("/big.bin", { backpressure: true });

    const frames = 16;
    const total = frames * CHUNK;
    let received = 0;
    let peak = 0;

    // One chunk per macrotask — a destination that consumes far slower than the source delivers.
    const consumed = (async () => {
        for await (const buf of stream) {
            received += buf.length;
            peak = Math.max(peak, stream.readableLength + stream.writableLength);
            await tick();
        }
    })();

    for (let i = 0; i < frames; i += 1) socket.write(dataFrame(RID, payload, total));
    socket.write(endFrame(RID));

    await done;
    await consumed;

    assert.strictEqual(received, total, "every byte has to arrive, backpressure must not drop any");
    assert.ok(events.includes("pause"), "the socket must be paused while the consumer is behind");
    assert.ok(events.includes("resume"), "and it has to come back up again");
    assert.strictEqual(socket.isPaused(), false, "the socket must not be left paused");
    assert.strictEqual(client._readPauses, 0, "pause and resume have to balance out");
    assert.ok(peak <= 4 * CHUNK,
        `the buffer must stay near one frame, not grow with the rate difference (peak ${peak})`);
});

// (b) The three REST callers and the AI tool share their client and fall back to the metadata
// client, where a pause would freeze directory browsing. Without the option nothing may change:
// every frame is written through unconditionally and the socket is never touched.
test("without the option readFile buffers unconditionally and never touches the socket", async () => {
    const { client, socket, events } = createClient();
    const { stream, done } = client.readFile("/big.bin");

    const frames = 16;
    const total = frames * CHUNK;
    for (let i = 0; i < frames; i += 1) socket.write(dataFrame(RID, payload, total));
    socket.write(endFrame(RID));

    await done;

    assert.deepStrictEqual(events, [], "the socket must not be paused or resumed");
    assert.strictEqual(socket.isPaused(), false);
    assert.strictEqual(stream.listenerCount("close"), 0, "no bookkeeping listener may be attached");
    assert.strictEqual(client._readPauses, 0);
    // Nobody read a single byte, yet the whole file went into the stream: unbounded buffering,
    // exactly the behaviour every existing caller relies on.
    assert.ok(stream.readableLength + stream.writableLength >= total,
        "everything has to pile up in the stream, as before");

    let buffered = 0;
    for await (const buf of stream) buffered += buf.length;
    assert.strictEqual(buffered, total, "and it all has to be readable afterwards");
});

// One socket read can carry several frames, and the parser hands them all on before the pause takes
// effect. A second pause without a resume in between would never be undone.
test("two overflowing frames in one socket chunk pause the socket exactly once", async () => {
    const { client, socket, events } = createClient();
    const { stream } = client.readFile("/big.bin", { backpressure: true });
    const total = 2 * CHUNK;

    socket.write(Buffer.concat([dataFrame(RID, payload, total), dataFrame(RID, payload, total)]));
    await tick();

    assert.deepStrictEqual(events, ["pause"]);
    assert.strictEqual(client._readPauses, 1);

    stream.resume();
    await tick();

    assert.deepStrictEqual(events, ["pause", "resume"], "one resume, not one per pause attempt");
    assert.strictEqual(client._readPauses, 0);
});

// (c) FileTransfer destroys the source stream in its finally — on a watchdog abort, on a cancel and
// on any error. No drain follows a destroyed stream, so the release has to come from elsewhere.
test("a stream destroyed mid-read leaves no paused socket behind", async () => {
    const { client, socket } = createClient();
    const { stream } = client.readFile("/big.bin", { backpressure: true });

    socket.write(dataFrame(RID, payload, 10 * CHUNK));
    await tick();
    assert.strictEqual(socket.isPaused(), true, "precondition: the read is paused");

    stream.destroy(new Error("Transfer cancelled"));
    await tick();

    assert.strictEqual(socket.isPaused(), false, "a destroyed stream must release the socket");
    assert.strictEqual(client._readPauses, 0);
});

// (c) The same for the error path: a connection loss rejects every pending request, and the read
// that was holding the socket down has to let go with it.
test("a connection loss while the read is paused releases the socket", async () => {
    const { client, socket } = createClient();
    // The abort rejects the readiness promise too, and nobody in this test awaits it.
    client.waitForReady().catch(() => {});
    const { done } = client.readFile("/big.bin", { backpressure: true });
    done.catch(() => {});

    socket.write(dataFrame(RID, payload, 10 * CHUNK));
    await tick();
    assert.strictEqual(socket.isPaused(), true, "precondition: the read is paused");

    socket.emit("close");
    await tick();

    assert.strictEqual(socket.isPaused(), false, "an aborted read must release the socket");
    assert.strictEqual(client._readPauses, 0);
    await assert.rejects(done, /Connection closed/);
});

// (c) FileEnd can share a socket read with the last data frame, so it arrives while the read is
// paused. Nobody has read the payload at that point and the stream is ended, so no drain will ever
// come — waiting for one would keep the socket down for good.
test("a FileEnd arriving while the read is paused releases the socket immediately", async () => {
    const { client, socket } = createClient();
    const { stream, done } = client.readFile("/big.bin", { backpressure: true });

    socket.write(Buffer.concat([dataFrame(RID, payload, CHUNK), endFrame(RID)]));
    await done;

    assert.strictEqual(socket.isPaused(), false, "no drain can follow the end of the stream");
    assert.strictEqual(client._readPauses, 0);

    let buffered = 0;
    for await (const buf of stream) buffered += buf.length;
    assert.strictEqual(buffered, CHUNK, "the payload is still there, waiting to be read");
});

// A drain that fires after its read is over must not resume a socket that a later read is holding
// down — the listener has to come off with the release, not merely be guarded against.
test("a drain from a finished read cannot resume the socket for a later one", async () => {
    const { client, socket } = createClient();

    const first = client.readFile("/a.bin", { backpressure: true });
    socket.write(dataFrame(1, payload, 10 * CHUNK));
    await tick();
    assert.strictEqual(socket.isPaused(), true);

    first.stream.destroy();
    await tick();
    assert.strictEqual(socket.isPaused(), false);

    const second = client.readFile("/b.bin", { backpressure: true });
    socket.write(dataFrame(2, payload, 10 * CHUNK));
    await tick();
    assert.strictEqual(socket.isPaused(), true, "precondition: the second read holds the socket");

    first.stream.emit("drain");
    await tick();

    assert.strictEqual(socket.isPaused(), true, "a stale drain must not lift a foreign pause");
    assert.strictEqual(client._readPauses, 1);

    second.stream.destroy();
    await tick();
    assert.strictEqual(socket.isPaused(), false);
    assert.strictEqual(client._readPauses, 0);
});

// Two reads on one client are not what the transfer does, but the counter has to be right anyway:
// resuming on the first release would undo a pause the other read still needs.
test("the socket only resumes once the last paused read has let go", async () => {
    const { client, socket } = createClient();

    const first = client.readFile("/a.bin", { backpressure: true });
    const second = client.readFile("/b.bin", { backpressure: true });

    socket.write(Buffer.concat([dataFrame(1, payload, 10 * CHUNK), dataFrame(2, payload, 10 * CHUNK)]));
    await tick();
    assert.strictEqual(client._readPauses, 2, "both reads are behind");

    first.stream.destroy();
    await tick();
    assert.strictEqual(socket.isPaused(), true, "the second read still needs the socket held");

    second.stream.destroy();
    await tick();
    assert.strictEqual(socket.isPaused(), false);
    assert.strictEqual(client._readPauses, 0);
});
