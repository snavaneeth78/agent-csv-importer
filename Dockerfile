# Demo image: the library, the demo server and the Vite web app. Postgres runs as its own compose service.
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY csv-importer/package.json csv-importer/
COPY demo/package.json demo/
RUN npm ci --no-audit --no-fund
COPY . .
ENV VITE_HOST=0.0.0.0
EXPOSE 5173
CMD ["npm", "run", "-w", "@distru/csv-importer-demo", "dev"]
