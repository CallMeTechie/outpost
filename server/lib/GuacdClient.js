/**
 * Copyright 2024 Vadim Pronin
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified by Mathias Wagner, 2026
 */

const SessionManager = require('./SessionManager');
const logger = require('../utils/logger');

// Guacamole lengths count code points, not UTF-16 units.
const readElement = (data, start) => {
    const dot = data.indexOf('.', start);
    if (dot <= start || !/^\d+$/.test(data.slice(start, dot))) return null;
    let end = dot + 1;
    for (let left = Number(data.slice(start, dot)); left > 0; left--) {
        if (end >= data.length) return null;
        end += data.codePointAt(end) > 0xFFFF ? 2 : 1;
    }
    if (end >= data.length) return null;
    return { value: data.slice(dot + 1, end), terminator: data[end], next: end + 1 };
};

// Only at instruction boundaries (start of string or after ';'), so filenames or clipboard text
// containing "5.error," never count; the message itself may contain commas.
const findErrorInstruction = (data) => {
    for (let start = 0; start < data.length; start = data.indexOf(';', start) + 1 || data.length) {
        if (!data.startsWith('5.error,', start)) continue;
        const message = readElement(data, start + 8);
        if (message?.terminator !== ',') continue;
        const status = readElement(data, message.next);
        if (status?.terminator !== ';' || !/^\d+$/.test(status.value)) continue;
        return { message: message.value, status: Number(status.value) };
    }
    return null;
};

class GuacdClient {

    constructor(options) {
        this.sessionId = options.sessionId;
        this.generation = options.generation;
        this.engineSessionId = options.engineSessionId || options.sessionId;
        this.connectionSettings = options.connectionSettings || {};
        this.joinConnectionId = options.joinConnectionId || null;
        this.onReadyCallback = options.onReady || null;
        this.onCloseCallback = options.onClose || null;
        this.onDataCallback = options.onData || null;

        this.connection = null;
        this.connectionId = null;
        this.connectionType = this.connectionSettings.connection?.type || 'vnc';
        this.recordingEnabled = options.recordingEnabled || false;
        this.auditLogId = options.auditLogId || null;

        this.state = 'connecting';
        this.handshakeComplete = false;
        this.receivedBuffer = '';

        this.GUAC_AUDIO = this.connectionSettings.enableAudio !== false ? ['audio/L8', 'audio/L16'] : [];
        this.GUAC_VIDEO = [];
        this.GUAC_IMAGE = ['image/png', 'image/jpeg', 'image/webp'];

        this.keepAliveInterval = null;
        this.engineSocket = options.existingSocket || null;
        if (!this.engineSocket) {
            throw new Error('GuacdClient requires an existingSocket (engine data connection)');
        }
    }

    connect() {
        logger.debug('GuacdClient connecting', {
            sessionId: this.sessionId,
            connectionType: this.connectionType,
            joining: !!this.joinConnectionId,
        });
        this.connection = this.engineSocket;

        this.sendOpCode(this.joinConnectionId
            ? ['select', this.joinConnectionId]
            : ['select', this.connectionType]
        );

        this.connection.on('data', (data) => {
            this.receivedBuffer += data;
            if (!this.handshakeComplete) {
                if (this.receivedBuffer.indexOf(';') !== -1) this.completeHandshake();
                return;
            }
            this.processData();
        });

        this.connection.on('close', () => this.handleClose('connection closed'));
        this.connection.on('error', (error) => this.handleError(error));

        this.keepAliveInterval = setInterval(() => {
            if (this.state === 'open') this.sendOpCode(['nop']);
        }, 5000);

        return this;
    }

    completeHandshake() {
        const delimiterPos = this.receivedBuffer.indexOf(';');
        const serverHandshake = this.receivedBuffer.substring(0, delimiterPos);
        this.receivedBuffer = this.receivedBuffer.substring(delimiterPos + 1);

        const attributes = serverHandshake.split(',');
        const conn = this.connectionSettings.connection || {};

        if (!this.joinConnectionId && this.recordingEnabled && this.auditLogId) {
            conn['recording-path'] = '/tmp/outpost-recordings';
            conn['recording-name'] = this.engineSessionId;
            conn['create-recording-path'] = 'true';
        }

        this.sendOpCode(['size', conn.width || 1024, conn.height || 768, conn.dpi || 96]);
        this.sendOpCode(['audio'].concat(this.GUAC_AUDIO));
        this.sendOpCode(['video'].concat(this.GUAC_VIDEO));
        this.sendOpCode(['image'].concat(this.GUAC_IMAGE));

        const connectionOptions = ['connect'];
        for (let i = 1; i < attributes.length; i++) {
            if (i === 1) {
                connectionOptions.push('VERSION_1_5_0');
            } else if (this.joinConnectionId) {
                connectionOptions.push('');
            } else {
                const name = attributes[i].substring(attributes[i].indexOf('.') + 1);
                connectionOptions.push(conn[name] !== undefined ? conn[name] : '');
            }
        }
        this.sendOpCode(connectionOptions);

        logger.info('GuacdClient connect instruction', {
            sessionId: this.sessionId,
            argc: connectionOptions.length - 1,
            serverArgsIncludingVersion: attributes.length - 1,
            joining: !!this.joinConnectionId,
        });

        this.handshakeComplete = true;
        this.state = 'open';
        this.processData();
    }

    processData() {
        const delimiterPos = this.receivedBuffer.lastIndexOf(';');
        if (delimiterPos === -1) return;

        const dataToSend = this.receivedBuffer.substring(0, delimiterPos + 1);
        this.receivedBuffer = this.receivedBuffer.substring(delimiterPos + 1);
        if (!dataToSend) return;

        const errorMatch = findErrorInstruction(dataToSend);
        if (errorMatch) {
            const { message: errorMessage, status } = errorMatch;
            logger.error('Guacd error received', { sessionId: this.sessionId, error: errorMessage, status });
            // Forward data to client first so it can display the error message
            try { this.onDataCallback?.(dataToSend); } catch {}
            this.handleClose(`error: ${errorMessage}`, status);
            return;
        }

        if (!this.connectionId && dataToSend.includes('5.ready')) {
            const match = /5\.ready,(\d+)\.([^;]+);/.exec(dataToSend);
            if (match?.[2]) {
                this.connectionId = match[2];
                logger.info('Connection ready', { sessionId: this.sessionId, connectionId: this.connectionId });
                if (!this.joinConnectionId) {
                    SessionManager.updateConnectionId(this.sessionId, this.connectionId);
                }
                this.onReadyCallback?.(this.connectionId);
            }
        }

        try { this.onDataCallback?.(dataToSend); } catch {}
    }

    send(data) {
        if (this.state === 'closed' || !this.connection) return;
        try {
            this.connection.write(data);
        } catch (e) {
            this.handleError(e);
        }
    }

    sendOpCode(parts) {
        const formatted = parts.map(p => {
            const str = p === null ? '' : String(p);
            return str.length + '.' + str;
        }).join(',') + ';';
        this.send(formatted);
    }

    handleClose(reason, guacStatus = null) {
        if (this.state === 'closed') return;
        this.state = 'closed';
        logger.info('Connection closed', { sessionId: this.sessionId, reason });
        this.cleanup();
        this.onCloseCallback?.(reason);
        if (this.joinConnectionId) return;
        if (reason === 'connection closed') SessionManager.beginCloseGrace(this.sessionId, this.generation);
        else SessionManager.onMasterConnectionClosed(this.sessionId, reason, { guacStatus, generation: this.generation });
    }

    handleError(error) {
        if (this.state === 'closed') return;
        logger.error('Connection error', { sessionId: this.sessionId, error: error?.message });
        this.handleClose(`error: ${error?.message || 'unknown'}`);
    }

    cleanup() {
        if (this.keepAliveInterval) {
            clearInterval(this.keepAliveInterval);
            this.keepAliveInterval = null;
        }
        if (this.connection) {
            this.connection.removeAllListeners();
            try { this.connection.end(); } catch {}
            try { this.connection.destroy(); } catch {}
            this.connection = null;
        }
    }

    close() {
        this.handleClose('manual close');
    }
}

module.exports = GuacdClient;
