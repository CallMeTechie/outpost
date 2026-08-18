#ifndef OUTPOST_SSH_H
#define OUTPOST_SSH_H

#include "session.h"
#include "ssh_common.h"

struct outpost_control_plane;

typedef struct {
    const char* username;
    const char* password;
    const char* private_key;
    const char* passphrase;
} ssh_credentials_t;

int outpost_ssh_start(outpost_session_t* session,
                      struct outpost_control_plane* cp);

void outpost_ssh_resize(outpost_session_t* session,
                        uint16_t cols, uint16_t rows);

int outpost_tunnel_start(outpost_session_t* session,
                         struct outpost_control_plane* cp);

int outpost_ssh_exec_command(struct outpost_control_plane* cp,
                             const char* request_id,
                             const char* host, uint16_t port,
                             const ssh_credentials_t* creds,
                             const char* command,
                             const jump_host_t* jump_hosts,
                             int jump_count);

int outpost_ssh_exec_batch(struct outpost_control_plane* cp,
                           const char* request_id,
                           const char* host, uint16_t port,
                           const ssh_credentials_t* creds,
                           const char* const* ids,
                           const char* const* commands,
                           int command_count,
                           const jump_host_t* jump_hosts,
                           int jump_count);

int outpost_extract_jump_hosts(const outpost_session_t* session,
                               jump_host_t* jump_hosts,
                               int max_jump_hosts);

#endif
