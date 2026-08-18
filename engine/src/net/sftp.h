#ifndef OUTPOST_SFTP_H
#define OUTPOST_SFTP_H

#include "session.h"

struct outpost_control_plane;

int outpost_sftp_start(outpost_session_t* session,
                       struct outpost_control_plane* cp);

#endif
