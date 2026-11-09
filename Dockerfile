# 本番用コンテナ(Cloud Run / AWS App Runner / Render などで動かせます)
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
# データ(SQLite)は永続ボリュームに置く
ENV DATA_DIR=/data
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK CMD node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
