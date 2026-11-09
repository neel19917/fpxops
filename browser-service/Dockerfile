# Build from the REPO ROOT so the unmodified extension/ can be copied in:
#   docker build -f browser-service/Dockerfile -t fpx-browser .
FROM node:20-bookworm-slim

# Debian's Chromium honors --load-extension (stock Google Chrome does not),
# and ships for both amd64 and arm64. Xvfb gives it a display to run headed.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb xauth dumb-init \
      fonts-liberation fonts-noto-color-emoji fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY browser-service/package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY browser-service/src ./src
COPY extension ./extension

ENV CHROME_PATH=/usr/bin/chromium \
    EXT_PATH=/app/extension \
    PROFILE_ROOT=/data/profiles \
    PORT=8080

# Per-user Chrome profiles (each rep's own FreightPOP login) live in /data —
# mount a volume there (docker run -v …:/data, or a Railway volume). No VOLUME
# instruction: Railway rejects Dockerfiles that use it.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
EXPOSE 8080

ENTRYPOINT ["dumb-init", "--"]
CMD ["xvfb-run", "-a", "--server-args=-screen 0 2560x1600x24", "node", "src/index.js"]
