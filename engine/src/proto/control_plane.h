#ifndef OUTPOST_CONTROL_PLANE_H
#define OUTPOST_CONTROL_PLANE_H

#include <stdint.h>
#include <stdbool.h>
#include <pthread.h>
#include <openssl/ssl.h>

#define OUTPOST_ENGINE_VERSION "0.1.1"

typedef struct outpost_control_plane {
    int sock_fd;
    bool connected;
    bool running;

    char* server_host;
    uint16_t server_port;

    char* registration_token;

    pthread_t read_thread;
    pthread_t keepalive_thread;
    uint32_t keepalive_interval_ms;
    uint32_t reconnect_delay_ms;

    pthread_mutex_t send_mutex;

    bool use_tls;
    SSL_CTX* ssl_ctx;
    SSL* ssl;
} outpost_control_plane_t;

outpost_control_plane_t* outpost_cp_create(const char* server_host,
                                           uint16_t server_port,
                                           const char* registration_token,
                                           bool use_tls,
                                           const char* ca_cert_path,
                                           bool tls_skip_verify);

int outpost_cp_start(outpost_control_plane_t* cp);

void outpost_cp_stop(outpost_control_plane_t* cp);

void outpost_cp_destroy(outpost_control_plane_t* cp);

int outpost_cp_send(outpost_control_plane_t* cp, const uint8_t* buf, size_t len);

int outpost_cp_send_session_result(outpost_control_plane_t* cp,
                                   const char* session_id,
                                   bool success,
                                   const char* error_message,
                                   const char* connection_id);

int outpost_cp_send_session_closed(outpost_control_plane_t* cp,
                                    const char* session_id,
                                    const char* reason);

int outpost_cp_open_data_connection(const outpost_control_plane_t* cp,
                                    const char* session_id);

int outpost_cp_send_exec_result(outpost_control_plane_t* cp,
                                const char* request_id,
                                bool success,
                                const char* stdout_data,
                                const char* stderr_data,
                                int32_t exit_code,
                                const char* error_message);

int outpost_cp_send_port_check_result(outpost_control_plane_t* cp,
                                       const char* request_id,
                                       const char** ids,
                                       const bool* online,
                                       size_t count);

typedef struct {
    const char* id;
    bool success;
    const char* stdout_data;
    const char* stderr_data;
    int32_t exit_code;
    const char* error_message;
} exec_batch_entry_t;

int outpost_cp_send_exec_batch_result(outpost_control_plane_t* cp,
                                      const char* request_id,
                                      bool success,
                                      const char* error_message,
                                      const exec_batch_entry_t* entries,
                                      size_t count);

int outpost_cp_upload_recording(outpost_control_plane_t* cp,
                                const char* session_id,
                                const char* file_path);

#endif
