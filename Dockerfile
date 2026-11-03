FROM node:24-bookworm-slim

ARG CODEX_CLI_VERSION=0.163.0
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates git \
    && npm install -g "@openai/codex@${CODEX_CLI_VERSION}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /app /data /home/node/.codex \
    && chown -R node:node /app /data /home/node/.codex

ENV NODE_ENV=production \
    GENERATION_HOST=0.0.0.0 \
    GENERATION_PORT=17374 \
    GENERATION_DATA_DIR=/data \
    CODEX_HOME=/home/node/.codex
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
USER node
EXPOSE 17374
CMD ["node", "src/server.js"]
