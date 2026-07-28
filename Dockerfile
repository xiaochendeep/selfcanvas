FROM node:22-bookworm

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 ca-certificates curl ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ARG TARGETARCH
ARG ANYCAP_VERSION=0.3.6
RUN set -eux; \
  version="${ANYCAP_VERSION#v}"; \
  archive="anycap_${version}_linux_${TARGETARCH}.tar.gz"; \
  release="https://github.com/anycap-ai/anycap/releases/download/v${version}"; \
  curl -fsSL --retry 3 "${release}/${archive}" -o "/tmp/${archive}"; \
  curl -fsSL --retry 3 "${release}/checksums.txt" -o /tmp/checksums.txt; \
  grep " ${archive}$" /tmp/checksums.txt > /tmp/anycap.sha256; \
  (cd /tmp && sha256sum -c anycap.sha256); \
  tar -xzf "/tmp/${archive}" -C /usr/local/bin anycap; \
  chmod 0755 /usr/local/bin/anycap; \
  rm -f "/tmp/${archive}" /tmp/checksums.txt /tmp/anycap.sha256; \
  anycap --version

COPY package*.json ./
RUN npm ci

COPY . .

EXPOSE 8787 8790
