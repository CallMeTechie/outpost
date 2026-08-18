#ifndef OUTPOST_LOG_H
#define OUTPOST_LOG_H

typedef enum {
    OUTPOST_LOG_ERROR,
    OUTPOST_LOG_WARN,
    OUTPOST_LOG_INFO,
    OUTPOST_LOG_DEBUG,
    OUTPOST_LOG_TRACE,
} outpost_log_level_t;

void outpost_log_set_level(outpost_log_level_t level);

void outpost_log_msg(outpost_log_level_t level, const char* message);

#define LOG_IMPL(lvl, fmt, ...) \
    do { \
        char log_buf_[2048]; \
        snprintf(log_buf_, sizeof(log_buf_), fmt, ##__VA_ARGS__); \
        outpost_log_msg(lvl, log_buf_); \
    } while (0)

#define LOG_ERROR(fmt, ...) LOG_IMPL(OUTPOST_LOG_ERROR, fmt, ##__VA_ARGS__)
#define LOG_WARN(fmt, ...)  LOG_IMPL(OUTPOST_LOG_WARN,  fmt, ##__VA_ARGS__)
#define LOG_INFO(fmt, ...)  LOG_IMPL(OUTPOST_LOG_INFO,  fmt, ##__VA_ARGS__)
#define LOG_DEBUG(fmt, ...) LOG_IMPL(OUTPOST_LOG_DEBUG, fmt, ##__VA_ARGS__)
#define LOG_TRACE(fmt, ...) LOG_IMPL(OUTPOST_LOG_TRACE, fmt, ##__VA_ARGS__)

#endif
