# ---- Build stage ----
FROM node:20-alpine AS build
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json nest-cli.json ./
COPY src ./src
RUN npm run build

# ---- Runtime stage ----
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Short commit for GET /api/version — passed in by docker-compose.yml from
# ProdRelease.bat (see CHANGELOG.md "Versioning").
ARG GIT_COMMIT=dev
ENV GIT_COMMIT=$GIT_COMMIT

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=build /app/dist ./dist

# Blynk TCP listener — the Airlock connects here.
EXPOSE 1234

CMD ["node", "dist/main"]
