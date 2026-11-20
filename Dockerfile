FROM node:22-slim

# ffmpeg — монтаж и субтитры; DejaVu — шрифт с узбекскими буквами oʻ и gʻ.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY series ./series
COPY music ./music
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    STUDIO_DATA_DIR=/data \
    STUDIO_SERIES_DIR=/data/series \
    PORT=8080
EXPOSE 8080
CMD ["node", "dist/src/cli.js", "serve"]
