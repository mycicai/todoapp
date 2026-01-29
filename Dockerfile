FROM node:25-alpine

WORKDIR /app

# 安装 sqlite3 编译所需的依赖
RUN echo "http://mirrors.aliyun.com/alpine/v$(cat /etc/alpine-release | cut -d'.' -f1,2)/main/" > /etc/apk/repositories && \
    echo "http://mirrors.aliyun.com/alpine/v$(cat /etc/alpine-release | cut -d'.' -f1,2)/community/" >> /etc/apk/repositories && \
    apk update && \
    apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js .
COPY index.html .
COPY style.css .
COPY app.js .

EXPOSE 3000

ENV NODE_ENV=production
ENV PORT=3000

CMD ["npm", "start"]
