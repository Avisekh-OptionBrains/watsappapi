# App Platform builds from the repository root. Local Compose still uses gateway/Dockerfile.
FROM node:20-alpine AS build
WORKDIR /app
COPY gateway/package.json gateway/package-lock.json ./
RUN npm ci
COPY gateway/tsconfig.json ./
COPY gateway/src ./src
COPY gateway/scripts ./scripts
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3100
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=10 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/index.js"]
