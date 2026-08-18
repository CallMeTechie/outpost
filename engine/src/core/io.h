#ifndef OUTPOST_IO_H
#define OUTPOST_IO_H

#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <openssl/ssl.h>

#define FRAME_HEADER_SIZE 4

int outpost_read_exact(int fd, uint8_t* buf, size_t len);
int outpost_write_exact(int fd, const uint8_t* buf, size_t len);

int outpost_tcp_connect(const char* host, uint16_t port);

SSL_CTX* outpost_tls_client_ctx_create(const char* ca_cert_path, bool skip_verify);
SSL* outpost_tls_handshake(SSL_CTX* ctx, int fd);
void outpost_tls_cleanup(SSL* ssl);

int outpost_read_exact_s(int fd, SSL* ssl, uint8_t* buf, size_t len);
int outpost_write_exact_s(int fd, SSL* ssl, const uint8_t* buf, size_t len);
int outpost_send_frame_s(int fd, SSL* ssl, const uint8_t* data, size_t len,
                         pthread_mutex_t* mutex);
uint8_t* outpost_read_frame_s(int fd, SSL* ssl, uint32_t max_size, uint32_t* out_len);

#define outpost_send_frame(fd, data, len, mutex) outpost_send_frame_s(fd, NULL, data, len, mutex)
#define outpost_read_frame(fd, max_size, out_len) outpost_read_frame_s(fd, NULL, max_size, out_len)

int outpost_tls_proxy_start(SSL* ssl, int tls_fd);

#endif
