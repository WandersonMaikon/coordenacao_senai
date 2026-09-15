#!/bin/bash
# Liga o backend ao OpenWA (container openwa_retencao) — rodar UMA vez no servidor,
# depois que o openwa_retencao estiver "healthy":
#
#   bash scripts/configurar-whatsapp.sh
#
# O que faz: lê a chave admin que o OpenWA gerou no primeiro start, cria com ela
# uma chave "operator" pro backend, grava OPENWA_URL/OPENWA_API_KEY no .env e
# recria o node_retencao (restart simples não relê o .env).
# Nenhuma chave é mostrada na tela. Se o .env já tiver uma chave que funciona,
# não faz nada — pode rodar de novo sem medo.

set -e
cd "$(dirname "$0")/.."

URL_INTERNA="http://openwa_retencao:2785/api"

if [ ! -f .env ]; then
  echo "ERRO: não achei o .env em $(pwd)."
  exit 1
fi

if ! docker compose ps --status running openwa_retencao | grep -q openwa_retencao; then
  echo "ERRO: o container openwa_retencao não está rodando."
  echo "Suba com: docker compose up -d --build openwa_retencao"
  exit 1
fi

# Já configurado e funcionando? Então não cria outra chave.
CHAVE_ATUAL=$(grep '^OPENWA_API_KEY=' .env | tail -n 1 | cut -d= -f2- | tr -d '\r"')
if [ -n "$CHAVE_ATUAL" ]; then
  CODIGO=$(docker compose exec -T node_retencao curl -s -o /dev/null -w '%{http_code}' \
    -H "X-API-Key: $CHAVE_ATUAL" "$URL_INTERNA/sessions" || true)
  if [ "$CODIGO" = "200" ]; then
    echo "O .env já tem uma chave do OpenWA funcionando. Nada a fazer."
    exit 0
  fi
  echo "A chave que está no .env não funciona (HTTP $CODIGO). Vou criar uma nova."
fi

ADMIN=$(docker compose exec -T openwa_retencao cat /app/data/.api-key | tr -d '\r\n')
if [ -z "$ADMIN" ]; then
  echo "ERRO: não consegui ler a chave admin em /app/data/.api-key."
  exit 1
fi

RESPOSTA=$(docker compose exec -T node_retencao curl -s -X POST "$URL_INTERNA/auth/api-keys" \
  -H "X-API-Key: $ADMIN" -H "Content-Type: application/json" \
  -d '{"name":"coor360-backend","role":"operator"}')

OPERADOR=$(echo "$RESPOSTA" | grep -o 'owa_k1_[A-Za-z0-9_-]*' | head -n 1)

if [ -z "$OPERADOR" ]; then
  echo "ERRO ao criar a chave. Resposta do OpenWA (chaves escondidas):"
  echo "$RESPOSTA" | sed 's/owa_k1_[A-Za-z0-9_-]*/***/g'
  exit 1
fi

cp .env .env.backup-whatsapp
sed -i '/^OPENWA_URL=/d;/^OPENWA_API_KEY=/d' .env
# Garante quebra de linha antes de acrescentar, caso o .env não termine com uma.
[ -n "$(tail -c1 .env)" ] && echo >> .env
echo "OPENWA_URL=$URL_INTERNA" >> .env
echo "OPENWA_API_KEY=$OPERADOR" >> .env

docker compose up -d --force-recreate node_retencao

echo ""
echo "PRONTO: chave gravada no .env (cópia do anterior em .env.backup-whatsapp)"
echo "e node_retencao recriado. Abra /whatsapp e clique em Conectar WhatsApp."
