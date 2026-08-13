// Cria (ou reseta a senha de) um usuário do painel.
// Uso: node scripts/criar-usuario.js <usuario> <senha> ["Nome opcional"]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const prisma = require('../src/config/prisma');

async function main() {
    const [, , usuario, senha, nome] = process.argv;

    if (!usuario || !senha) {
        console.error('Uso: node scripts/criar-usuario.js <usuario> <senha> ["Nome opcional"]');
        process.exit(1);
    }

    const senhaHash = bcrypt.hashSync(senha, 10);

    const registro = await prisma.usuario.upsert({
        where: { usuario },
        update: { senhaHash, ...(nome ? { nome } : {}) },
        create: { usuario, senhaHash, nome: nome || null }
    });

    console.log(`Usuário "${registro.usuario}" (id ${registro.id}) criado/atualizado com sucesso.`);
}

main()
    .catch((erro) => {
        console.error('Erro ao criar usuário:', erro.message);
        process.exit(1);
    })
    .finally(() => prisma.$disconnect());