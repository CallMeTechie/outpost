#ifndef OUTPOST_CONNECTION_H
#define OUTPOST_CONNECTION_H

#include "session.h"

struct outpost_control_plane;

int outpost_connection_start_guac(outpost_session_t* session,
                                  struct outpost_control_plane* cp);

int outpost_connection_start_ssh(outpost_session_t* session,
                                 struct outpost_control_plane* cp);

int outpost_connection_start_telnet(outpost_session_t* session,
                                    struct outpost_control_plane* cp);

void outpost_connection_close(outpost_session_t* session);

int outpost_connection_join_guac(outpost_session_t* session,
                                 struct outpost_control_plane* cp);

#endif
