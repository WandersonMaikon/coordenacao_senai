# Mesma imagem oficial do Node do Docker Hub, servida pelo espelho público da AWS.
# O Docker Hub limita downloads anônimos por IP e o deploy da escola passou a
# falhar com 429 (Too Many Requests) no build; o espelho não tem esse limite.
FROM public.ecr.aws/docker/library/node:22

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npx prisma generate

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy && node server.js"]
