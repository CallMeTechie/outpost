#include "control_plane.h"
#include "io.h"
#include "session.h"
#include "connection.h"
#include "ssh.h"
#include "telnet.h"
#include "sftp.h"
#include "ftp.h"
#include "http_fetch.h"
#include "websocket.h"
#include "log.h"

#include <errno.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <netdb.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <unistd.h>

#include "control_plane_builder.h"
#include "control_plane_reader.h"

#define CP_MAX_FRAME_SIZE (16 * 1024 * 1024)

extern outpost_session_manager_t g_session_manager;

static int finalize_and_send(flatcc_builder_t* b, int fd, SSL* ssl, pthread_mutex_t* mutex) {
    size_t size;
    uint8_t* buf = (uint8_t*)flatcc_builder_finalize_buffer(b, &size);
    int ret = outpost_send_frame_s(fd, ssl, buf, size, mutex);
    flatcc_builder_clear(b);
    free(buf);
    return ret;
}

static int cp_send(outpost_control_plane_t* cp, flatcc_builder_t* b) {
    return finalize_and_send(b, cp->sock_fd, cp->ssl, &cp->send_mutex);
}

static int send_engine_hello(outpost_control_plane_t* cp) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_EngineHello);
    Outpost_ControlPlane_Envelope_engine_hello_start(&builder);
    Outpost_ControlPlane_EngineHello_version_create_str(&builder, OUTPOST_ENGINE_VERSION);
    if (cp->registration_token && cp->registration_token[0] != '\0')
        Outpost_ControlPlane_EngineHello_registration_token_create_str(&builder, cp->registration_token);
    Outpost_ControlPlane_Envelope_engine_hello_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

static int send_pong(outpost_control_plane_t* cp, uint64_t timestamp) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_Pong);
    Outpost_ControlPlane_Envelope_pong_start(&builder);
    Outpost_ControlPlane_Pong_timestamp_add(&builder, timestamp);
    Outpost_ControlPlane_Envelope_pong_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

static session_type_t map_session_type(Outpost_ControlPlane_SessionType_enum_t t) {
    switch (t) {
        case Outpost_ControlPlane_SessionType_VNC:    return SESSION_TYPE_VNC;
        case Outpost_ControlPlane_SessionType_RDP:    return SESSION_TYPE_RDP;
        case Outpost_ControlPlane_SessionType_SSH:    return SESSION_TYPE_SSH;
        case Outpost_ControlPlane_SessionType_SFTP:   return SESSION_TYPE_SFTP;
        case Outpost_ControlPlane_SessionType_Telnet: return SESSION_TYPE_TELNET;
        case Outpost_ControlPlane_SessionType_Tunnel: return SESSION_TYPE_TUNNEL;
        case Outpost_ControlPlane_SessionType_WebSocket: return SESSION_TYPE_WEBSOCKET;
        case Outpost_ControlPlane_SessionType_Demo:   return SESSION_TYPE_DEMO;
        default: return SESSION_TYPE_VNC;
    }
}

static int start_session_connection(outpost_session_t* session,
                                    outpost_control_plane_t* cp,
                                    session_type_t stype) {
    switch (stype) {
        case SESSION_TYPE_VNC:
        case SESSION_TYPE_RDP:
        case SESSION_TYPE_DEMO:
            return outpost_connection_start_guac(session, cp);
        case SESSION_TYPE_SSH:
            return outpost_connection_start_ssh(session, cp);
        case SESSION_TYPE_TELNET:
            return outpost_connection_start_telnet(session, cp);
        case SESSION_TYPE_SFTP:
            return outpost_ftp_is_ftp_session(session)
                ? outpost_ftp_start(session, cp)
                : outpost_sftp_start(session, cp);
        case SESSION_TYPE_TUNNEL:
            return outpost_tunnel_start(session, cp);
        case SESSION_TYPE_WEBSOCKET:
            return outpost_websocket_start(session, cp);
        default:
            LOG_WARN("Unsupported session type: %d", stype);
            return -1;
    }
}

static void handle_engine_hello_ack(outpost_control_plane_t* cp,
                                    Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_EngineHelloAck_table_t ack =
        Outpost_ControlPlane_Envelope_engine_hello_ack(envelope);
    if (ack && Outpost_ControlPlane_EngineHelloAck_accepted(ack)) {
        LOG_INFO("Server accepted engine (server version: %s)",
                 Outpost_ControlPlane_EngineHelloAck_server_version(ack));
        cp->connected = true;
    } else {
        const char* reason = ack ? Outpost_ControlPlane_EngineHelloAck_reason(ack) : NULL;
        LOG_ERROR("Server rejected engine connection: %s",
                  reason && *reason ? reason : "no reason given");
        cp->running = false;
    }
}

static void handle_ping(outpost_control_plane_t* cp,
                        Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_Ping_table_t ping =
        Outpost_ControlPlane_Envelope_ping(envelope);
    uint64_t ts = ping ? Outpost_ControlPlane_Ping_timestamp(ping) : 0;
    send_pong(cp, ts);
    LOG_TRACE("Ping/Pong (ts=%lu)", (unsigned long)ts);
}

static void store_jump_hosts_as_params(outpost_session_t* session,
                                       Outpost_ControlPlane_JumpHost_vec_t jump_hosts) {
    if (!jump_hosts) return;
    size_t count = Outpost_ControlPlane_JumpHost_vec_len(jump_hosts);
    if (count == 0) return;
    if (count > MAX_JUMP_HOSTS) count = MAX_JUMP_HOSTS;

    char buf[32];
    snprintf(buf, sizeof(buf), "%zu", count);
    outpost_session_add_param(session, "jumpHostCount", buf);

    for (size_t i = 0; i < count; i++) {
        Outpost_ControlPlane_JumpHost_table_t jh =
            Outpost_ControlPlane_JumpHost_vec_at(jump_hosts, i);
        char key[64];

        const char* host = Outpost_ControlPlane_JumpHost_host(jh);
        snprintf(key, sizeof(key), "jumpHost%zu_host", i);
        outpost_session_add_param(session, key, host ? host : "");

        snprintf(key, sizeof(key), "jumpHost%zu_port", i);
        snprintf(buf, sizeof(buf), "%u", Outpost_ControlPlane_JumpHost_port(jh));
        outpost_session_add_param(session, key, buf);

        const char* username = Outpost_ControlPlane_JumpHost_username(jh);
        snprintf(key, sizeof(key), "jumpHost%zu_username", i);
        outpost_session_add_param(session, key, username ? username : "");

        const char* password = Outpost_ControlPlane_JumpHost_password(jh);
        snprintf(key, sizeof(key), "jumpHost%zu_password", i);
        outpost_session_add_param(session, key, password ? password : "");

        const char* private_key = Outpost_ControlPlane_JumpHost_private_key(jh);
        snprintf(key, sizeof(key), "jumpHost%zu_privateKey", i);
        outpost_session_add_param(session, key, private_key ? private_key : "");

        const char* passphrase = Outpost_ControlPlane_JumpHost_passphrase(jh);
        snprintf(key, sizeof(key), "jumpHost%zu_passphrase", i);
        outpost_session_add_param(session, key, passphrase ? passphrase : "");
    }
}

static void extract_jump_hosts_from_msg(Outpost_ControlPlane_JumpHost_vec_t jh_vec,
                                        jump_host_t* jump_hosts, int* jump_count) {
    *jump_count = 0;
    if (!jh_vec) return;
    size_t count = Outpost_ControlPlane_JumpHost_vec_len(jh_vec);
    if (count == 0) return;
    if (count > MAX_JUMP_HOSTS) count = MAX_JUMP_HOSTS;

    for (size_t i = 0; i < count; i++) {
        Outpost_ControlPlane_JumpHost_table_t jh =
            Outpost_ControlPlane_JumpHost_vec_at(jh_vec, i);
        memset(&jump_hosts[i], 0, sizeof(jump_host_t));

        const char* host = Outpost_ControlPlane_JumpHost_host(jh);
        if (host) snprintf(jump_hosts[i].host, sizeof(jump_hosts[i].host), "%s", host);
        jump_hosts[i].port = Outpost_ControlPlane_JumpHost_port(jh);

        const char* username = Outpost_ControlPlane_JumpHost_username(jh);
        if (username) snprintf(jump_hosts[i].username, sizeof(jump_hosts[i].username), "%s", username);

        jump_hosts[i].password = (char*)Outpost_ControlPlane_JumpHost_password(jh);
        jump_hosts[i].private_key = (char*)Outpost_ControlPlane_JumpHost_private_key(jh);
        jump_hosts[i].passphrase = (char*)Outpost_ControlPlane_JumpHost_passphrase(jh);
    }
    *jump_count = (int)count;
}

static void handle_session_open(outpost_control_plane_t* cp,
                                Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_SessionOpen_table_t open_msg =
        Outpost_ControlPlane_Envelope_session_open(envelope);
    if (!open_msg) {
        LOG_WARN("Invalid SessionOpen message");
        return;
    }

    const char* sid = Outpost_ControlPlane_SessionOpen_session_id(open_msg);
    const char* host = Outpost_ControlPlane_SessionOpen_host(open_msg);
    uint16_t port = Outpost_ControlPlane_SessionOpen_port(open_msg);
    session_type_t stype = map_session_type(
        Outpost_ControlPlane_SessionOpen_session_type(open_msg));

    LOG_INFO("SessionOpen: id=%s type=%d host=%s port=%u", sid, stype, host, port);

    outpost_session_t* session = outpost_sm_create(
        &g_session_manager, sid, stype, host, port);

    if (!session) {
        outpost_cp_send_session_result(cp, sid, false,
            "Failed to create session", NULL);
        return;
    }

    Outpost_ControlPlane_ConnectionParam_vec_t params =
        Outpost_ControlPlane_SessionOpen_params(open_msg);
    if (params) {
        size_t n = Outpost_ControlPlane_ConnectionParam_vec_len(params);
        for (size_t i = 0; i < n; i++) {
            Outpost_ControlPlane_ConnectionParam_table_t p =
                Outpost_ControlPlane_ConnectionParam_vec_at(params, i);
            outpost_session_add_param(session,
                Outpost_ControlPlane_ConnectionParam_key(p),
                Outpost_ControlPlane_ConnectionParam_value(p));
        }
    }

    store_jump_hosts_as_params(session,
        Outpost_ControlPlane_SessionOpen_jump_hosts(open_msg));

    if (start_session_connection(session, cp, stype) != 0) {
        outpost_cp_send_session_result(cp, sid, false,
            "Failed to start connection", NULL);
        outpost_sm_remove(&g_session_manager, sid);
    }
}

static void handle_session_close(outpost_control_plane_t* cp,
                                 Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_SessionClose_table_t close_msg =
        Outpost_ControlPlane_Envelope_session_close(envelope);
    if (!close_msg) return;

    const char* sid = Outpost_ControlPlane_SessionClose_session_id(close_msg);
    LOG_INFO("SessionClose: id=%s", sid);

    outpost_sm_lock(&g_session_manager);
    outpost_session_t* session = outpost_sm_find_locked(&g_session_manager, sid);
    bool found = session != NULL;
    bool thread_active = false;
    if (session) {
        outpost_connection_close(session);
        thread_active = session->thread_active;
    }
    outpost_sm_unlock(&g_session_manager);

    if (found && !thread_active) {
        outpost_cp_send_session_closed(cp, sid, "closed by server");
        outpost_sm_remove(&g_session_manager, sid);
    }
}

static void handle_session_resize(Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_SessionResize_table_t resize_msg =
        Outpost_ControlPlane_Envelope_session_resize(envelope);
    if (!resize_msg) return;

    const char* sid = Outpost_ControlPlane_SessionResize_session_id(resize_msg);
    uint16_t cols = Outpost_ControlPlane_SessionResize_cols(resize_msg);
    uint16_t rows = Outpost_ControlPlane_SessionResize_rows(resize_msg);

    LOG_DEBUG("SessionResize: id=%s cols=%u rows=%u", sid, cols, rows);

    outpost_sm_request_resize(&g_session_manager, sid, cols, rows);
}

static void handle_session_join(outpost_control_plane_t* cp,
                                Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_SessionJoin_table_t join_msg =
        Outpost_ControlPlane_Envelope_session_join(envelope);
    if (!join_msg) return;

    const char* sid = Outpost_ControlPlane_SessionJoin_session_id(join_msg);
    LOG_INFO("SessionJoin: id=%s", sid);

    outpost_session_t* session = outpost_sm_find(&g_session_manager, sid);
    if (session) {
        if (outpost_connection_join_guac(session, cp) != 0)
            LOG_WARN("Failed to join session %s", sid);
    } else {
        LOG_WARN("SessionJoin: session not found: %s", sid);
    }
}

static void extract_ssh_credentials(Outpost_ControlPlane_ConnectionParam_vec_t params,
                                    ssh_credentials_t* creds) {
    creds->username = NULL;
    creds->password = NULL;
    creds->private_key = NULL;
    creds->passphrase = NULL;
    if (!params) return;

    size_t n = Outpost_ControlPlane_ConnectionParam_vec_len(params);
    for (size_t i = 0; i < n; i++) {
        Outpost_ControlPlane_ConnectionParam_table_t p =
            Outpost_ControlPlane_ConnectionParam_vec_at(params, i);
        const char* key = Outpost_ControlPlane_ConnectionParam_key(p);
        const char* val = Outpost_ControlPlane_ConnectionParam_value(p);
        if (strcmp(key, "username") == 0) creds->username = val;
        else if (strcmp(key, "password") == 0) creds->password = val;
        else if (strcmp(key, "privateKey") == 0) creds->private_key = val;
        else if (strcmp(key, "passphrase") == 0) creds->passphrase = val;
    }
}

static void handle_exec_command(outpost_control_plane_t* cp,
                                Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_ExecCommand_table_t exec_msg =
        Outpost_ControlPlane_Envelope_exec_command(envelope);
    if (!exec_msg) {
        LOG_WARN("Invalid ExecCommand message");
        return;
    }

    const char* req_id = Outpost_ControlPlane_ExecCommand_request_id(exec_msg);
    const char* host = Outpost_ControlPlane_ExecCommand_host(exec_msg);
    uint16_t port = Outpost_ControlPlane_ExecCommand_port(exec_msg);
    const char* command = Outpost_ControlPlane_ExecCommand_command(exec_msg);

    if (!req_id || !host || !command) {
        LOG_WARN("ExecCommand: missing required fields");
        return;
    }

    ssh_credentials_t creds;
    extract_ssh_credentials(Outpost_ControlPlane_ExecCommand_params(exec_msg), &creds);
    if (!creds.username) creds.username = "";

    jump_host_t jump_hosts[MAX_JUMP_HOSTS];
    int jump_count = 0;
    extract_jump_hosts_from_msg(
        Outpost_ControlPlane_ExecCommand_jump_hosts(exec_msg),
        jump_hosts, &jump_count);

    LOG_INFO("ExecCommand: req=%s host=%s:%u cmd=%.64s... (jump_hosts=%d)",
             req_id, host, port, command, jump_count);

    outpost_ssh_exec_command(cp, req_id, host, port, &creds, command,
                             jump_hosts, jump_count);
}

static void handle_exec_batch(outpost_control_plane_t* cp,
                              Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_ExecBatch_table_t batch_msg =
        Outpost_ControlPlane_Envelope_exec_batch(envelope);
    if (!batch_msg) {
        LOG_WARN("Invalid ExecBatch message");
        return;
    }

    const char* req_id = Outpost_ControlPlane_ExecBatch_request_id(batch_msg);
    const char* host = Outpost_ControlPlane_ExecBatch_host(batch_msg);
    uint16_t port = Outpost_ControlPlane_ExecBatch_port(batch_msg);

    if (!req_id || !host) {
        LOG_WARN("ExecBatch: missing required fields");
        return;
    }

    Outpost_ControlPlane_ExecBatchCommand_vec_t cmds =
        Outpost_ControlPlane_ExecBatch_commands(batch_msg);
    size_t count = cmds ? Outpost_ControlPlane_ExecBatchCommand_vec_len(cmds) : 0;
    if (count == 0) {
        LOG_WARN("ExecBatch: no commands (req=%s)", req_id);
        outpost_cp_send_exec_batch_result(cp, req_id, false,
                                          "No commands supplied", NULL, 0);
        return;
    }

    const char** ids = calloc(count, sizeof(char*));
    const char** commands = calloc(count, sizeof(char*));
    if (!ids || !commands) {
        free(ids);
        free(commands);
        outpost_cp_send_exec_batch_result(cp, req_id, false, "Out of memory", NULL, 0);
        return;
    }

    for (size_t i = 0; i < count; i++) {
        Outpost_ControlPlane_ExecBatchCommand_table_t c =
            Outpost_ControlPlane_ExecBatchCommand_vec_at(cmds, i);
        ids[i] = Outpost_ControlPlane_ExecBatchCommand_id(c);
        commands[i] = Outpost_ControlPlane_ExecBatchCommand_command(c);
    }

    ssh_credentials_t creds;
    extract_ssh_credentials(Outpost_ControlPlane_ExecBatch_params(batch_msg), &creds);
    if (!creds.username) creds.username = "";

    jump_host_t jump_hosts[MAX_JUMP_HOSTS];
    int jump_count = 0;
    extract_jump_hosts_from_msg(
        Outpost_ControlPlane_ExecBatch_jump_hosts(batch_msg),
        jump_hosts, &jump_count);

    LOG_INFO("ExecBatch: req=%s host=%s:%u commands=%zu (jump_hosts=%d)",
             req_id, host, port, count, jump_count);

    outpost_ssh_exec_batch(cp, req_id, host, port, &creds,
                           ids, commands, (int)count, jump_hosts, jump_count);

    free(ids);
    free(commands);
}

static bool check_port_open(const char* host, uint16_t port, uint32_t timeout_ms) {
    struct addrinfo hints = {0};
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    char port_str[8];
    snprintf(port_str, sizeof(port_str), "%u", port);

    struct addrinfo* res = NULL;
    if (getaddrinfo(host, port_str, &hints, &res) != 0 || !res) {
        if (res) freeaddrinfo(res);
        return false;
    }

    int fd = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
    if (fd < 0) {
        freeaddrinfo(res);
        return false;
    }

    int flags = fcntl(fd, F_GETFL, 0);
    fcntl(fd, F_SETFL, flags | O_NONBLOCK);

    int rc = connect(fd, res->ai_addr, res->ai_addrlen);
    freeaddrinfo(res);

    if (rc == 0) {
        close(fd);
        return true;
    }

    if (errno != EINPROGRESS) {
        close(fd);
        return false;
    }

    struct pollfd pfd = { .fd = fd, .events = POLLOUT };
    rc = poll(&pfd, 1, (int)timeout_ms);

    if (rc <= 0) {
        close(fd);
        return false;
    }

    int err = 0;
    socklen_t len = sizeof(err);
    getsockopt(fd, SOL_SOCKET, SO_ERROR, &err, &len);
    close(fd);
    return err == 0;
}

typedef struct {
    outpost_control_plane_t* cp;
    char* request_id;
    char** ids;
    char** hosts;
    uint16_t* ports;
    size_t count;
    uint32_t timeout_ms;
} port_check_ctx_t;

static void free_port_check_ctx(port_check_ctx_t* ctx) {
    for (size_t i = 0; i < ctx->count; i++) {
        free(ctx->ids[i]);
        free(ctx->hosts[i]);
    }
    free(ctx->ids);
    free(ctx->hosts);
    free(ctx->ports);
    free(ctx->request_id);
    free(ctx);
}

static void* port_check_thread(void* arg) {
    port_check_ctx_t* ctx = (port_check_ctx_t*)arg;
    bool* results = calloc(ctx->count, sizeof(bool));
    if (!results) {
        free_port_check_ctx(ctx);
        return NULL;
    }

    for (size_t i = 0; i < ctx->count; i++)
        results[i] = check_port_open(ctx->hosts[i], ctx->ports[i], ctx->timeout_ms);

    outpost_cp_send_port_check_result(ctx->cp, ctx->request_id,
                                      (const char**)ctx->ids, results, ctx->count);
    free(results);
    free_port_check_ctx(ctx);
    return NULL;
}

static void handle_port_check(outpost_control_plane_t* cp,
                               Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_PortCheck_table_t pc_msg =
        Outpost_ControlPlane_Envelope_port_check(envelope);
    if (!pc_msg) return;

    const char* req_id = Outpost_ControlPlane_PortCheck_request_id(pc_msg);
    uint32_t timeout_ms = Outpost_ControlPlane_PortCheck_timeout_ms(pc_msg);
    if (timeout_ms == 0) timeout_ms = 2000;

    Outpost_ControlPlane_PortCheckTarget_vec_t targets =
        Outpost_ControlPlane_PortCheck_targets(pc_msg);
    size_t count = targets ? Outpost_ControlPlane_PortCheckTarget_vec_len(targets) : 0;
    if (!req_id || count == 0) return;

    port_check_ctx_t* ctx = calloc(1, sizeof(port_check_ctx_t));
    ctx->cp = cp;
    ctx->request_id = strdup(req_id);
    ctx->count = count;
    ctx->timeout_ms = timeout_ms;
    ctx->ids = calloc(count, sizeof(char*));
    ctx->hosts = calloc(count, sizeof(char*));
    ctx->ports = calloc(count, sizeof(uint16_t));

    for (size_t i = 0; i < count; i++) {
        Outpost_ControlPlane_PortCheckTarget_table_t t =
            Outpost_ControlPlane_PortCheckTarget_vec_at(targets, i);
        ctx->ids[i] = strdup(Outpost_ControlPlane_PortCheckTarget_id(t));
        ctx->hosts[i] = strdup(Outpost_ControlPlane_PortCheckTarget_host(t));
        ctx->ports[i] = Outpost_ControlPlane_PortCheckTarget_port(t);
    }

    pthread_t thread;
    if (pthread_create(&thread, NULL, port_check_thread, ctx) != 0) {
        free_port_check_ctx(ctx);
        return;
    }
    pthread_detach(thread);
}

static void handle_http_fetch(outpost_control_plane_t* cp,
                               Outpost_ControlPlane_Envelope_table_t envelope) {
    Outpost_ControlPlane_HttpFetch_table_t fetch_msg =
        Outpost_ControlPlane_Envelope_http_fetch(envelope);
    if (!fetch_msg) {
        LOG_WARN("Invalid HttpFetch message");
        return;
    }

    const char* req_id = Outpost_ControlPlane_HttpFetch_request_id(fetch_msg);
    const char* method = Outpost_ControlPlane_HttpFetch_method(fetch_msg);
    const char* url = Outpost_ControlPlane_HttpFetch_url(fetch_msg);
    const char* body = Outpost_ControlPlane_HttpFetch_body(fetch_msg);
    uint32_t timeout_ms = Outpost_ControlPlane_HttpFetch_timeout_ms(fetch_msg);
    bool insecure = Outpost_ControlPlane_HttpFetch_insecure(fetch_msg);

    if (!req_id || !method || !url) {
        LOG_WARN("HttpFetch: missing required fields");
        return;
    }

    Outpost_ControlPlane_HttpHeader_vec_t headers =
        Outpost_ControlPlane_HttpFetch_headers(fetch_msg);
    size_t header_count = headers ? Outpost_ControlPlane_HttpHeader_vec_len(headers) : 0;

    const char** header_names = NULL;
    const char** header_values = NULL;

    if (header_count > 0) {
        header_names = calloc(header_count, sizeof(char*));
        header_values = calloc(header_count, sizeof(char*));
        for (size_t i = 0; i < header_count; i++) {
            Outpost_ControlPlane_HttpHeader_table_t h =
                Outpost_ControlPlane_HttpHeader_vec_at(headers, i);
            header_names[i] = Outpost_ControlPlane_HttpHeader_name(h);
            header_values[i] = Outpost_ControlPlane_HttpHeader_value(h);
        }
    }

    outpost_http_fetch(cp, req_id, method, url, header_names, header_values,
                       header_count, body, timeout_ms, insecure);

    free(header_names);
    free(header_values);
}

static void handle_message(outpost_control_plane_t* cp, const uint8_t* buf) {
    Outpost_ControlPlane_Envelope_table_t envelope = Outpost_ControlPlane_Envelope_as_root(buf);
    if (!envelope) {
        LOG_WARN("Failed to parse envelope");
        return;
    }

    switch (Outpost_ControlPlane_Envelope_msg_type(envelope)) {
        case Outpost_ControlPlane_MessageType_EngineHelloAck:
            handle_engine_hello_ack(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_Ping:
            handle_ping(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_Pong: {
            Outpost_ControlPlane_Pong_table_t pong =
                Outpost_ControlPlane_Envelope_pong(envelope);
            uint64_t ts = pong ? Outpost_ControlPlane_Pong_timestamp(pong) : 0;
            LOG_TRACE("Pong received (ts=%lu)", (unsigned long)ts);
            break;
        }
        case Outpost_ControlPlane_MessageType_SessionOpen:
            handle_session_open(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_SessionClose:
            handle_session_close(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_SessionResize:
            handle_session_resize(envelope);
            break;
        case Outpost_ControlPlane_MessageType_SessionJoin:
            handle_session_join(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_ExecCommand:
            handle_exec_command(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_ExecBatch:
            handle_exec_batch(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_PortCheck:
            handle_port_check(cp, envelope);
            break;
        case Outpost_ControlPlane_MessageType_HttpFetch:
            handle_http_fetch(cp, envelope);
            break;
        default:
            LOG_WARN("Unknown message type: %d",
                     Outpost_ControlPlane_Envelope_msg_type(envelope));
            break;
    }
}

static bool read_one_frame(outpost_control_plane_t* cp) {
    uint32_t payload_len;
    uint8_t* payload = outpost_read_frame_s(cp->sock_fd, cp->ssl, CP_MAX_FRAME_SIZE, &payload_len);
    if (!payload) {
        if (cp->running) {
            LOG_WARN("Control plane connection lost");
            cp->connected = false;
        }
        return false;
    }

    handle_message(cp, payload);
    free(payload);
    return true;
}

static void* read_loop(void* arg) {
    outpost_control_plane_t* cp = (outpost_control_plane_t*)arg;
    while (cp->running && read_one_frame(cp));
    cp->running = false;
    return NULL;
}

static int send_ping(outpost_control_plane_t* cp) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_Ping);
    Outpost_ControlPlane_Envelope_ping_start(&builder);

    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    Outpost_ControlPlane_Ping_timestamp_add(&builder,
        (uint64_t)now.tv_sec * 1000 + now.tv_nsec / 1000000);

    Outpost_ControlPlane_Envelope_ping_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

static void* keepalive_loop(void* arg) {
    outpost_control_plane_t* cp = (outpost_control_plane_t*)arg;

    while (cp->running) {
        struct timespec ts;
        ts.tv_sec = cp->keepalive_interval_ms / 1000;
        ts.tv_nsec = (cp->keepalive_interval_ms % 1000) * 1000000L;
        nanosleep(&ts, NULL);

        if (!cp->running || !cp->connected) continue;

        if (send_ping(cp) != 0)
            LOG_WARN("Failed to send keepalive ping");
    }

    return NULL;
}

outpost_control_plane_t* outpost_cp_create(const char* server_host,
                                           uint16_t server_port,
                                           const char* registration_token,
                                           bool use_tls,
                                           const char* ca_cert_path,
                                           bool tls_skip_verify) {
    outpost_control_plane_t* cp = calloc(1, sizeof(outpost_control_plane_t));
    if (!cp) return NULL;

    cp->server_host = strdup(server_host);
    cp->server_port = server_port;
    cp->registration_token = registration_token ? strdup(registration_token) : strdup("");

    if (!cp->server_host || !cp->registration_token) {
        free(cp->server_host);
        free(cp->registration_token);
        free(cp);
        return NULL;
    }

    cp->sock_fd = -1;
    cp->connected = false;
    cp->running = false;
    cp->keepalive_interval_ms = 10000;
    cp->reconnect_delay_ms = 5000;
    cp->use_tls = use_tls;
    cp->ssl_ctx = NULL;
    cp->ssl = NULL;

    if (use_tls) {
        cp->ssl_ctx = outpost_tls_client_ctx_create(ca_cert_path, tls_skip_verify);
        if (!cp->ssl_ctx) {
            LOG_ERROR("Failed to create TLS context");
            free(cp->server_host);
            free(cp->registration_token);
            free(cp);
            return NULL;
        }
        LOG_INFO("TLS enabled for control plane connections");
    }

    pthread_mutex_init(&cp->send_mutex, NULL);
    return cp;
}

int outpost_cp_start(outpost_control_plane_t* cp) {
    LOG_INFO("Connecting to control plane at %s:%u%s",
             cp->server_host, cp->server_port,
             cp->use_tls ? " (TLS)" : "");

    cp->sock_fd = outpost_tcp_connect(cp->server_host, cp->server_port);
    if (cp->sock_fd < 0) {
        LOG_ERROR("Failed to connect to control plane");
        return -1;
    }

    if (cp->use_tls) {
        cp->ssl = outpost_tls_handshake(cp->ssl_ctx, cp->sock_fd);
        if (!cp->ssl) {
            LOG_ERROR("TLS handshake failed for control plane");
            close(cp->sock_fd);
            cp->sock_fd = -1;
            return -1;
        }
    }

    cp->running = true;

    if (send_engine_hello(cp) != 0) {
        LOG_ERROR("Failed to send EngineHello");
        close(cp->sock_fd);
        cp->sock_fd = -1;
        cp->running = false;
        return -1;
    }

    if (pthread_create(&cp->read_thread, NULL, read_loop, cp) != 0) {
        LOG_ERROR("Failed to start read thread");
        close(cp->sock_fd);
        cp->sock_fd = -1;
        cp->running = false;
        return -1;
    }

    if (pthread_create(&cp->keepalive_thread, NULL, keepalive_loop, cp) != 0) {
        LOG_ERROR("Failed to start keepalive thread");
        cp->running = false;
        pthread_join(cp->read_thread, NULL);
        close(cp->sock_fd);
        cp->sock_fd = -1;
        return -1;
    }

    LOG_INFO("Control plane client started");
    return 0;
}

void outpost_cp_stop(outpost_control_plane_t* cp) {
    if (!cp->running) return;

    LOG_INFO("Stopping control plane client");
    cp->running = false;

    if (cp->sock_fd >= 0)
        shutdown(cp->sock_fd, SHUT_RDWR);

    pthread_join(cp->read_thread, NULL);
    pthread_join(cp->keepalive_thread, NULL);

    if (cp->ssl) {
        outpost_tls_cleanup(cp->ssl);
        cp->ssl = NULL;
    }

    if (cp->sock_fd >= 0) {
        close(cp->sock_fd);
        cp->sock_fd = -1;
    }
}

void outpost_cp_destroy(outpost_control_plane_t* cp) {
    if (!cp) return;
    outpost_cp_stop(cp);
    if (cp->ssl_ctx) {
        SSL_CTX_free(cp->ssl_ctx);
        cp->ssl_ctx = NULL;
    }
    pthread_mutex_destroy(&cp->send_mutex);
    free(cp->server_host);
    free(cp->registration_token);
    free(cp);
}

int outpost_cp_send(outpost_control_plane_t* cp, const uint8_t* buf, size_t len) {
    if (!cp->connected || cp->sock_fd < 0) return -1;
    return outpost_send_frame_s(cp->sock_fd, cp->ssl, buf, len, &cp->send_mutex);
}

int outpost_cp_send_session_result(outpost_control_plane_t* cp,
                                   const char* session_id,
                                   bool success,
                                   const char* error_message,
                                   const char* connection_id) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_SessionOpenResult);

    Outpost_ControlPlane_Envelope_session_open_result_start(&builder);
    Outpost_ControlPlane_SessionOpenResult_session_id_create_str(&builder, session_id);
    Outpost_ControlPlane_SessionOpenResult_success_add(&builder, success);

    if (!success) {
        Outpost_ControlPlane_SessionOpenResult_error_code_add(&builder,
            Outpost_ControlPlane_ErrorCode_ConnectionFailed);
        if (error_message)
            Outpost_ControlPlane_SessionOpenResult_error_message_create_str(&builder, error_message);
    }

    if (connection_id)
        Outpost_ControlPlane_SessionOpenResult_connection_id_create_str(&builder, connection_id);

    Outpost_ControlPlane_Envelope_session_open_result_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

int outpost_cp_send_session_closed(outpost_control_plane_t* cp,
                                    const char* session_id,
                                    const char* reason) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_SessionClosed);

    Outpost_ControlPlane_Envelope_session_closed_start(&builder);
    Outpost_ControlPlane_SessionClosed_session_id_create_str(&builder, session_id);
    if (reason)
        Outpost_ControlPlane_SessionClosed_reason_create_str(&builder, reason);
    Outpost_ControlPlane_Envelope_session_closed_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

typedef struct { int fd; SSL* ssl; } cp_raw_conn_t;

static int cp_connect_raw(const outpost_control_plane_t* cp, cp_raw_conn_t* c) {
    c->fd = outpost_tcp_connect(cp->server_host, cp->server_port);
    if (c->fd < 0) return -1;
    c->ssl = NULL;
    if (cp->use_tls) {
        c->ssl = outpost_tls_handshake(cp->ssl_ctx, c->fd);
        if (!c->ssl) { close(c->fd); return -1; }
    }
    return 0;
}

static void cp_close_raw(cp_raw_conn_t* c) {
    if (c->ssl) outpost_tls_cleanup(c->ssl);
    close(c->fd);
}

int outpost_cp_open_data_connection(const outpost_control_plane_t* cp,
                                    const char* session_id) {
    LOG_DEBUG("Opening data connection for session %s%s",
             session_id, cp->use_tls ? " (TLS)" : "");

    cp_raw_conn_t conn;
    if (cp_connect_raw(cp, &conn) != 0) {
        LOG_ERROR("Failed to open data connection for session %s", session_id);
        return -1;
    }

    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_ConnectionReady);
    Outpost_ControlPlane_Envelope_connection_ready_start(&builder);
    Outpost_ControlPlane_ConnectionReady_session_id_create_str(&builder, session_id);
    Outpost_ControlPlane_Envelope_connection_ready_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    if (finalize_and_send(&builder, conn.fd, conn.ssl, NULL) != 0) {
        LOG_ERROR("Failed to send ConnectionReady for session %s", session_id);
        cp_close_raw(&conn);
        return -1;
    }

    if (conn.ssl) {
        int plain_fd = outpost_tls_proxy_start(conn.ssl, conn.fd);
        if (plain_fd < 0) {
            LOG_ERROR("Failed to start TLS proxy for session %s", session_id);
            cp_close_raw(&conn);
            return -1;
        }
        LOG_DEBUG("TLS data connection proxied for session %s (plain_fd=%d)", session_id, plain_fd);
        return plain_fd;
    }

    LOG_DEBUG("Data connection established for session %s (fd=%d)", session_id, conn.fd);
    return conn.fd;
}

int outpost_cp_send_exec_result(outpost_control_plane_t* cp,
                                const char* request_id,
                                bool success,
                                const char* stdout_data,
                                const char* stderr_data,
                                int32_t exit_code,
                                const char* error_message) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder,
        Outpost_ControlPlane_MessageType_ExecCommandResult);

    Outpost_ControlPlane_Envelope_exec_command_result_start(&builder);
    Outpost_ControlPlane_ExecCommandResult_request_id_create_str(&builder, request_id);
    Outpost_ControlPlane_ExecCommandResult_success_add(&builder, success);
    Outpost_ControlPlane_ExecCommandResult_exit_code_add(&builder, exit_code);

    if (stdout_data)
        Outpost_ControlPlane_ExecCommandResult_stdout_data_create_str(&builder, stdout_data);
    if (stderr_data)
        Outpost_ControlPlane_ExecCommandResult_stderr_data_create_str(&builder, stderr_data);
    if (error_message)
        Outpost_ControlPlane_ExecCommandResult_error_message_create_str(&builder, error_message);

    Outpost_ControlPlane_Envelope_exec_command_result_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

int outpost_cp_send_exec_batch_result(outpost_control_plane_t* cp,
                                      const char* request_id,
                                      bool success,
                                      const char* error_message,
                                      const exec_batch_entry_t* entries,
                                      size_t count) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder,
        Outpost_ControlPlane_MessageType_ExecBatchResult);

    Outpost_ControlPlane_Envelope_exec_batch_result_start(&builder);
    Outpost_ControlPlane_ExecBatchResult_request_id_create_str(&builder, request_id);
    Outpost_ControlPlane_ExecBatchResult_success_add(&builder, success);
    if (error_message)
        Outpost_ControlPlane_ExecBatchResult_error_message_create_str(&builder, error_message);

    if (entries && count > 0) {
        Outpost_ControlPlane_ExecBatchResult_results_start(&builder);
        for (size_t i = 0; i < count; i++) {
            Outpost_ControlPlane_ExecBatchResult_results_push_start(&builder);
            Outpost_ControlPlane_ExecBatchEntry_id_create_str(&builder,
                entries[i].id ? entries[i].id : "");
            Outpost_ControlPlane_ExecBatchEntry_success_add(&builder, entries[i].success);
            if (entries[i].stdout_data)
                Outpost_ControlPlane_ExecBatchEntry_stdout_data_create_str(&builder, entries[i].stdout_data);
            if (entries[i].stderr_data)
                Outpost_ControlPlane_ExecBatchEntry_stderr_data_create_str(&builder, entries[i].stderr_data);
            Outpost_ControlPlane_ExecBatchEntry_exit_code_add(&builder, entries[i].exit_code);
            if (entries[i].error_message)
                Outpost_ControlPlane_ExecBatchEntry_error_message_create_str(&builder, entries[i].error_message);
            Outpost_ControlPlane_ExecBatchResult_results_push_end(&builder);
        }
        Outpost_ControlPlane_ExecBatchResult_results_end(&builder);
    }

    Outpost_ControlPlane_Envelope_exec_batch_result_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

int outpost_cp_send_port_check_result(outpost_control_plane_t* cp,
                                       const char* request_id,
                                       const char** ids,
                                       const bool* online,
                                       size_t count) {
    flatcc_builder_t builder;
    flatcc_builder_init(&builder);

    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder,
        Outpost_ControlPlane_MessageType_PortCheckResult);

    Outpost_ControlPlane_Envelope_port_check_result_start(&builder);
    Outpost_ControlPlane_PortCheckResult_request_id_create_str(&builder, request_id);

    Outpost_ControlPlane_PortCheckResult_results_start(&builder);
    for (size_t i = 0; i < count; i++) {
        Outpost_ControlPlane_PortCheckResult_results_push_start(&builder);
        Outpost_ControlPlane_PortCheckEntry_id_create_str(&builder, ids[i]);
        Outpost_ControlPlane_PortCheckEntry_online_add(&builder, online[i]);
        Outpost_ControlPlane_PortCheckResult_results_push_end(&builder);
    }
    Outpost_ControlPlane_PortCheckResult_results_end(&builder);

    Outpost_ControlPlane_Envelope_port_check_result_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    return cp_send(cp, &builder);
}

int outpost_cp_upload_recording(outpost_control_plane_t* cp,
                                const char* session_id,
                                const char* file_path) {
    FILE* f = fopen(file_path, "rb");
    if (!f) { LOG_WARN("Recording file not found: %s", file_path); return -1; }

    fseek(f, 0, SEEK_END);
    long file_size = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (file_size <= 0) { fclose(f); return -1; }

    LOG_INFO("Uploading recording for session %s (%ld bytes)", session_id, file_size);

    cp_raw_conn_t conn;
    if (cp_connect_raw(cp, &conn) != 0) {
        LOG_ERROR("Failed to open upload connection for session %s", session_id);
        fclose(f);
        return -1;
    }

    flatcc_builder_t builder;
    flatcc_builder_init(&builder);
    Outpost_ControlPlane_Envelope_start_as_root(&builder);
    Outpost_ControlPlane_Envelope_msg_type_add(&builder, Outpost_ControlPlane_MessageType_RecordingUpload);
    Outpost_ControlPlane_Envelope_recording_upload_start(&builder);
    Outpost_ControlPlane_RecordingUpload_session_id_create_str(&builder, session_id);
    Outpost_ControlPlane_RecordingUpload_file_size_add(&builder, (uint64_t)file_size);
    Outpost_ControlPlane_Envelope_recording_upload_end(&builder);
    Outpost_ControlPlane_Envelope_end_as_root(&builder);

    if (finalize_and_send(&builder, conn.fd, conn.ssl, NULL) != 0) {
        LOG_ERROR("Failed to send RecordingUpload header for session %s", session_id);
        cp_close_raw(&conn);
        fclose(f);
        return -1;
    }

    uint8_t buf[32768];
    size_t total_sent = 0;
    int ret = 0;

    while (total_sent < (size_t)file_size) {
        size_t n = fread(buf, 1, sizeof(buf), f);
        if (n == 0) { ret = -1; break; }
        if (outpost_write_exact_s(conn.fd, conn.ssl, buf, n) != 0) { ret = -1; break; }
        total_sent += n;
    }

    fclose(f);
    cp_close_raw(&conn);

    if (ret == 0) {
        LOG_INFO("Recording uploaded for session %s (%zu bytes)", session_id, total_sent);
        unlink(file_path);
    }
    return ret;
}
