FROM node:18-alpine

WORKDIR /usr/src/app

RUN npm install --omit=dev

COPY . .

EXPOSE 3001

CMD ["node", "server.js"]