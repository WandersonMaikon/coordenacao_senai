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
docker compose --profile tunnel up -d --build

echo ""
echo "✅ Atualização concluída com sucesso!"
