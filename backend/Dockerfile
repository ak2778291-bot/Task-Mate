FROM node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production PORT=4000
EXPOSE 4000
# Node runs as non-root: the container has an OAuth refresh-token decryption key in its env.
USER node
CMD ["node", "src/index.js"]
