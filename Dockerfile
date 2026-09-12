ARG NAPCAT_IMAGE=mlikiowa/napcat-docker:v4.18.19

FROM node:22-alpine AS plugin-dependencies
WORKDIR /plugin
COPY plugins/qq-miniapp-openauth/package*.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM gcc:14-bookworm AS no-core-dump-builder
COPY no-core-dump.c /tmp/no-core-dump.c
RUN gcc -shared -fPIC -O2 -Wall -Wextra -Werror \
    -o /tmp/no-core-dump.so /tmp/no-core-dump.c

FROM ${NAPCAT_IMAGE}

COPY plugins/qq-miniapp-openauth /opt/qq-farm-bot/qq-miniapp-openauth
COPY --from=plugin-dependencies /plugin/node_modules /opt/qq-farm-bot/qq-miniapp-openauth/node_modules
COPY --from=no-core-dump-builder /tmp/no-core-dump.so /usr/local/lib/no-core-dump.so
COPY docker-entrypoint.sh /usr/local/bin/qq-farm-napcat-entrypoint
COPY bootstrap.cjs /opt/QQ/resources/app/loadNapCat.js

RUN chmod +x /usr/local/bin/qq-farm-napcat-entrypoint

ENTRYPOINT ["/usr/local/bin/qq-farm-napcat-entrypoint"]
