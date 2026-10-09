FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium xvfb nodejs tini ca-certificates fonts-liberation fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 1000 browser \
    && mkdir -p /profiles /downloads /etc/chromium/policies/managed \
    && chown browser:browser /profiles /downloads /etc/chromium/policies/managed

COPY launcher.js /opt/outpost-browser/launcher.js

USER browser
ENV DISPLAY=:99
EXPOSE 9300 9222
VOLUME ["/profiles", "/downloads"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/outpost-browser/launcher.js"]
