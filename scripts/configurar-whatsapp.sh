#!/bin/bash
# Liga o backend ao OpenWA (container openwa_retencao) — rodar UMA vez no servidor,
# depois que o openwa_retencao estiver "healthy":
#
#   bash scripts/configurar-whatsapp.sh
#
# O que faz: lê a chave admin que o OpenWA gerou no primeiro start, cria com ela
# uma chave "operator" pro backend, gera o segredo do webhook de entrada, grava
# OPENWA_URL/OPENWA_API_KEY/OPENWA_WEBHOOK_* no .env e recria o node_retencao
# (restart simples não relê o .env).
# Nenhuma chave é mostrada na tela. Se o .env já estiver completo e funcionando,
# não faz nada — pode rodar de novo sem medo.

set -e
cd "$(dirname "$0")/.."

URL_INTERNA="http://openwa_retencao:2785/api"
# O OpenWA chama o backend pelo nome do serviço na rede do compose: não sai da
# máquina nem passa pelo tunnel Cloudflare.
URL_WEBHOOK="http://node_retencao:3000/webhook/whatsapp"

if [ ! -f .env ]; then
  echo "ERRO: não achei o .env em $(pwd)."
  exit 1
fi

# Backup uma vez só, antes de qualquer escrita — senão o segundo bloco salvaria
# por cima uma cópia já alterada.
backup_env() {
  [ -f .env.backup-whatsapp ] || cp .env .env.backup-whatsapp
}

# ── Webhook de entrada (a resposta do aluno) ──
# Sem OPENWA_WEBHOOK_SECRET a rota /webhook/whatsapp responde 503 e nenhuma
# resposta é recebida. Gerado aqui pra ninguém precisar inventar um segredo.
ALTEROU_ENV=0
if ! grep -q '^OPENWA_WEBHOOK_SECRET=..*' .env; then
  SEGREDO=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  backup_env
  sed -i '/^OPENWA_WEBHOOK_URL=/d;/^OPENWA_WEBHOOK_SECRET=/d' .env
  [ -n "$(tail -c1 .env)" ] && echo >> .env
  echo "OPENWA_WEBHOOK_URL=$URL_WEBHOOK" >> .env
  echo "OPENWA_WEBHOOK_SECRET=$SEGREDO" >> .env
  ALTEROU_ENV=1
  echo "Segredo do webhook de entrada gerado e gravado no .env."
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
    echo "O .env já tem uma chave do OpenWA funcionando."
    if [ "$ALTEROU_ENV" = "1" ]; then
      # O segredo do webhook acabou de entrar no .env: o container precisa relê-lo.
      docker compose up -d --force-recreate node_retencao
      echo "node_retencao recriado pra carregar o segredo do webhook."
      echo "Reconecte o número em /whatsapp pra registrar o webhook na sessão."
    else
      echo "Nada a fazer."
    fi
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

# A resposta traz também o prefixo curto da chave (o mesmo "owa_k1_5…" do log),
# então pega o maior texto começando com owa_k1_ — é a chave completa.
OPERADOR=$(echo "$RESPOSTA" | grep -o 'owa_k1_[^"]*' | awk '{ print length, $0 }' | sort -nr | head -n 1 | cut -d' ' -f2-)

if [ -z "$OPERADOR" ]; then
  echo "ERRO ao criar a chave. Resposta do OpenWA (chaves escondidas):"
  echo "$RESPOSTA" | sed 's/owa_k1_[^"]*/***/g'
  exit 1
fi

# Só grava no .env uma chave que o OpenWA aceita de verdade.
CODIGO=$(docker compose exec -T node_retencao curl -s -o /dev/null -w '%{http_code}' \
  -H "X-API-Key: $OPERADOR" "$URL_INTERNA/sessions" || true)
if [ "$CODIGO" != "200" ]; then
  echo "ERRO: a chave criada não foi aceita pelo OpenWA (HTTP $CODIGO). O .env não foi alterado."
  echo "Campos da resposta (valores escondidos):"
  echo "$RESPOSTA" | sed 's/:\s*"[^"]*"/:"***"/g'
  exit 1
fi

backup_env
sed -i '/^OPENWA_URL=/d;/^OPENWA_API_KEY=/d' .env
# Garante quebra de linha antes de acrescentar, caso o .env não termine com uma.
[ -n "$(tail -c1 .env)" ] && echo >> .env
echo "OPENWA_URL=$URL_INTERNA" >> .env
echo "OPENWA_API_KEY=$OPERADOR" >> .env

docker compose up -d --force-recreate node_retencao

echo ""
echo "PRONTO: chave gravada no .env (cópia do anterior em .env.backup-whatsapp)"
echo "e node_retencao recriado. Abra /whatsapp e clique em Conectar WhatsApp."
