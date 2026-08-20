// Roda em todo deploy (via atualizar.sh) pra garantir que exista pelo menos um
// usuário de acesso ao painel. Só CRIA se SEED_ADMIN_USER ainda não existir no
// banco — nunca sobrescreve a senha de um usuário já existente, pra não resetar
// uma senha trocada depois pela coordenação. Se ele já existir mas ainda estiver
// com admin=false (ex.: usuário criado antes desse campo existir no schema),
// promove pra admin=true — é o único ajuste que este script faz em cima de um
// usuário já existente. Se as variáveis não estiverem definidas no .env, não
// faz nada (sai sem erro, não quebra o deploy).
require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');

async function main() {
    const { SEED_ADMIN_USER, SEED_ADMIN_PASSWORD } = process.env;

    if (!SEED_ADMIN_USER || !SEED_ADMIN_PASSWORD) {
        console.log('[seed-admin] SEED_ADMIN_USER/SEED_ADMIN_PASSWORD não definidos no .env — nada a fazer.');
        return;
    }

    const existente = await prisma.usuario.findUnique({ where: { usuario: SEED_ADMIN_USER } });
    if (existente) {
        if (!existente.admin) {
            await prisma.usuario.update({ where: { usuario: SEED_ADMIN_USER }, data: { admin: true } });
            console.log(`[seed-admin] Usuário "${SEED_ADMIN_USER}" já existia sem admin=true — corrigido.`);
        } else {
            console.log(`[seed-admin] Usuário "${SEED_ADMIN_USER}" já existe — nada a fazer.`);
        }
        return;
    }

    const senhaHash = bcrypt.hashSync(SEED_ADMIN_PASSWORD, 10);
    await prisma.usuario.create({ data: { usuario: SEED_ADMIN_USER, senhaHash, admin: true } });
    console.log(`[seed-admin] Usuário "${SEED_ADMIN_USER}" criado.`);
}

main()
    .catch((erro) => {
        console.error('[seed-admin] Erro:', erro.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());