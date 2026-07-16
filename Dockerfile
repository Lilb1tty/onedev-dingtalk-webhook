FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src

RUN addgroup -S app && adduser -S app -G app
USER app

ENV PORT=8099
EXPOSE 8099
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget --no-verbose --tries=1 --spider http://localhost:8099/health || exit 1

CMD ["node", "src/server.js"]
