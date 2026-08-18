#ifndef OUTPOST_CONFIG_H
#define OUTPOST_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

typedef struct outpost_config {
    char registration_token[256];
    char server_host[256];
    uint16_t server_port;
    bool tls;
    char ca_cert_path[512];
    bool tls_skip_verify;
} outpost_config_t;

int outpost_config_load(outpost_config_t* cfg);

#endif
