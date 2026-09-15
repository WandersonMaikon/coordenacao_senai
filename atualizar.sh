#!/bin/bash

set -e

echo "======================================"
echo "🔄 1. Puxando novidades do GitHub..."
echo "======================================"
cd ~/senai-retencao-backend
git pull

echo ""
echo "======================================"
echo "🐳 2. Reconstruindo e reiniciando os containers..."
echo "======================================"
# Só o node_retencao é reconstruído a cada deploy. O openwa_retencao é construído
# a partir do GitHub, e reconstruir derrubaria o WhatsApp conectado de todo mundo a
# cada push. O segundo "up" (sem --build) sobe o que estiver parado e só recria o
# OpenWA se a configuração dele no compose mudar. Para atualizar a versão do OpenWA:
#   docker compose up -d --build openwa_retencao
docker compose --profile tunnel up -d --build node_retencao
docker compose --profile tunnel up -d

echo ""
echo "======================================"
echo "👤 3. Garantindo usuário de acesso ao painel..."
echo "======================================"
docker compose exec -T node_retencao npm run seed-admin

echo ""
echo "✅ Atualização concluída com sucesso!"
