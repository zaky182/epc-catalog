FROM node:20-alpine

# Install poppler-utils for high-speed server-side PDF diagram rendering
RUN apk add --no-cache poppler-utils

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p /app/data /app/uploads /app/public/diagrams

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["node", "server.js"]
