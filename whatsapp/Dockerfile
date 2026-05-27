FROM node:18-bookworm

# node:18-bookworm já inclui a maioria das libs — só chromium e dumb-init são novos
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    dumb-init \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /usr/src/app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

EXPOSE 3002

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
