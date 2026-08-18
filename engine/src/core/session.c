#include "session.h"
#include "log.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

void outpost_sm_init(outpost_session_manager_t* sm) {
    memset(sm, 0, sizeof(outpost_session_manager_t));
    pthread_mutex_init(&sm->mutex, NULL);
}

outpost_session_t* outpost_sm_create(outpost_session_manager_t* sm,
                                     const char* session_id,
                                     session_type_t type,
                                     const char* host,
                                     uint16_t port) {
    pthread_mutex_lock(&sm->mutex);

    int free_slot = -1;
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sm->sessions[i].session_id[0] == '\0') {
            if (free_slot < 0) free_slot = i;
        } else if (strcmp(sm->sessions[i].session_id, session_id) == 0) {
            LOG_WARN("Session already exists: %s", session_id);
            pthread_mutex_unlock(&sm->mutex);
            return NULL;
        }
    }

    if (free_slot < 0) {
        LOG_ERROR("Maximum sessions reached (%d)", MAX_SESSIONS);
        pthread_mutex_unlock(&sm->mutex);
        return NULL;
    }

    outpost_session_t* session = &sm->sessions[free_slot];
    memset(session, 0, sizeof(outpost_session_t));

    snprintf(session->session_id, sizeof(session->session_id), "%s", session_id);
    session->type = type;
    session->state = SESSION_STATE_PENDING;
    snprintf(session->host, sizeof(session->host), "%s", host);
    session->port = port;
    session->data_fd = -1;
    session->join_pipe[0] = -1;
    session->join_pipe[1] = -1;
    session->guac_client = NULL;
    session->ssh_sock = -1;
    session->telnet_sock = -1;
    session->param_count = 0;

    sm->count++;

    LOG_INFO("Session created: %s (type=%d, target=%s:%d)", session_id, type, host, port);
    pthread_mutex_unlock(&sm->mutex);

    return session;
}

outpost_session_t* outpost_sm_find(outpost_session_manager_t* sm,
                                   const char* session_id) {
    pthread_mutex_lock(&sm->mutex);

    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sm->sessions[i].session_id[0] != '\0' &&
            strcmp(sm->sessions[i].session_id, session_id) == 0) {
            outpost_session_t* s = &sm->sessions[i];
            pthread_mutex_unlock(&sm->mutex);
            return s;
        }
    }

    pthread_mutex_unlock(&sm->mutex);
    return NULL;
}

void outpost_sm_lock(outpost_session_manager_t* sm) {
    pthread_mutex_lock(&sm->mutex);
}

void outpost_sm_unlock(outpost_session_manager_t* sm) {
    pthread_mutex_unlock(&sm->mutex);
}

outpost_session_t* outpost_sm_find_locked(outpost_session_manager_t* sm,
                                          const char* session_id) {
    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sm->sessions[i].session_id[0] != '\0' &&
            strcmp(sm->sessions[i].session_id, session_id) == 0)
            return &sm->sessions[i];
    }
    return NULL;
}

static void session_cleanup_resources(outpost_session_t* session) {
    for (int j = 0; j < session->param_count; j++) {
        free(session->params[j].value);
        session->params[j].value = NULL;
    }

    if (session->data_fd >= 0) {
        close(session->data_fd);
        session->data_fd = -1;
    }
    if (session->join_pipe[0] >= 0) {
        close(session->join_pipe[0]);
        session->join_pipe[0] = -1;
    }
    if (session->join_pipe[1] >= 0) {
        close(session->join_pipe[1]);
        session->join_pipe[1] = -1;
    }
}

static void session_remove_locked(outpost_session_manager_t* sm,
                                  outpost_session_t* s) {
    LOG_INFO("Session removed: %s", s->session_id);
    session_cleanup_resources(s);
    s->resize_pending = false;
    s->session_id[0] = '\0';
    sm->count--;
}

void outpost_sm_remove(outpost_session_manager_t* sm,
                       const char* session_id) {
    pthread_mutex_lock(&sm->mutex);

    outpost_session_t* s = outpost_sm_find_locked(sm, session_id);
    if (s)
        session_remove_locked(sm, s);

    pthread_mutex_unlock(&sm->mutex);
}

void outpost_sm_finish(outpost_session_manager_t* sm,
                       const char* session_id) {
    pthread_mutex_lock(&sm->mutex);

    outpost_session_t* s = outpost_sm_find_locked(sm, session_id);
    if (s) {
        s->guac_client = NULL;
        s->state = SESSION_STATE_CLOSED;
        s->thread_active = false;
        session_remove_locked(sm, s);
    }

    pthread_mutex_unlock(&sm->mutex);
}

void outpost_sm_request_resize(outpost_session_manager_t* sm,
                               const char* session_id,
                               uint16_t cols, uint16_t rows) {
    pthread_mutex_lock(&sm->mutex);

    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sm->sessions[i].session_id[0] != '\0' &&
            strcmp(sm->sessions[i].session_id, session_id) == 0) {
            sm->sessions[i].pending_cols = cols;
            sm->sessions[i].pending_rows = rows;
            sm->sessions[i].resize_pending = true;
            break;
        }
    }

    pthread_mutex_unlock(&sm->mutex);
}

const char* outpost_session_get_param(const outpost_session_t* session,
                                      const char* key) {
    for (int i = 0; i < session->param_count; i++) {
        if (strcmp(session->params[i].key, key) == 0)
            return session->params[i].value;
    }
    return NULL;
}

int outpost_session_add_param(outpost_session_t* session,
                              const char* key,
                              const char* value) {
    if (session->param_count >= MAX_PARAMS) {
        LOG_WARN("Max params reached for session %s", session->session_id);
        return -1;
    }

    snprintf(session->params[session->param_count].key,
             sizeof(session->params[session->param_count].key), "%s", key);
    session->params[session->param_count].value = strdup(value ? value : "");
    if (!session->params[session->param_count].value)
        return -1;
    session->param_count++;

    return 0;
}

void outpost_sm_destroy(outpost_session_manager_t* sm) {
    pthread_mutex_lock(&sm->mutex);

    for (int i = 0; i < MAX_SESSIONS; i++) {
        if (sm->sessions[i].session_id[0] != '\0') {
            session_cleanup_resources(&sm->sessions[i]);
            sm->sessions[i].session_id[0] = '\0';
        }
    }

    sm->count = 0;
    pthread_mutex_unlock(&sm->mutex);
    pthread_mutex_destroy(&sm->mutex);
}
