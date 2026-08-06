FROM node:24-slim

WORKDIR /app

# Install deps first so the layer caches across code changes.
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src

# SQLite lives on a mounted volume so meetings survive redeploys.
ENV DATABASE_PATH=/data/meetnish.db
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.ts"]
