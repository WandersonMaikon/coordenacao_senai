// Desfaz mensagens de WhatsApp marcadas como "enviada" que NÃO chegaram ao aluno.
//
// Aconteceu em 15-16/09/2026: com a conexão interna do WhatsApp Web quebrada
// ("sendIq called before startComms"), uma versão do worker enviava sem verificar o
// número, o OpenWA respondia "aceito" e a mensagem nunca saía.
//
// Uso (no servidor):
//   docker compose exec node_retencao node scripts/reverter-envios-whatsapp.js
//       → lista as mensagens "enviadas" dos últimos 3 dias (id, data, turma, aluno)
//   docker compose exec node_retencao node scripts/reverter-envios-whatsapp.js 12 13 14
//       → desfaz essas: volta pra "falhou" (pode entrar num novo envio), tira do
//         limite do dia e apaga o contato automático que o envio tinha criado.

require('dotenv').config();
const prisma = require('../src/config/prisma');

async function listar() {
    const desde = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const mensagens = await prisma.mensagemWhatsapp.findMany({
        where: { status: 'enviada', enviadaEm: { gte: desde } },
        orderBy: { enviadaEm: 'asc' },
        select: { id: true, enviadaEm: true, codigoTurma: true, nomeAluno: true }
    });
    if (mensagens.length === 0) {
        console.log('Nenhuma mensagem marcada como enviada nos últimos 3 dias.');
        return;
    }
    console.log('id\tenviada em\t\tturma\t\taluno');
    for (const m of mensagens) {
        const quando = m.enviadaEm.toLocaleString('pt-BR', { timeZone: 'America/Porto_Velho' });
        console.log(`${m.id}\t${quando}\t${m.codigoTurma}\t${m.nomeAluno || '—'}`);
    }
    console.log('\nConfira no celular quais NÃO chegaram e rode de novo passando os ids.');
}

async function reverter(ids) {
    for (const id of ids) {
        const mensagem = await prisma.mensagemWhatsapp.findUnique({ where: { id } });
        if (!mensagem) {
            console.log(`${id}: não encontrada`);
            continue;
        }
        if (mensagem.status !== 'enviada') {
            console.log(`${id}: está "${mensagem.status}", não "enviada" — ignorada`);
            continue;
        }

        // Só apaga o contato se for o automático deste envio — nunca um registrado à mão.
        if (mensagem.contatoId) {
            const contato = await prisma.contato.findUnique({ where: { id: mensagem.contatoId } });
            if (contato && contato.canal === 'whatsapp' && contato.observacao === 'Mensagem automática enviada pelo WhatsApp.') {
                await prisma.contato.delete({ where: { id: contato.id } });
            }
        }

        await prisma.mensagemWhatsapp.update({
            where: { id },
            data: {
                status: 'falhou',
                falhaDefinitiva: false,
                erro: 'Não chegou ao WhatsApp (conexão com problema) — pode entrar num novo envio',
                enviadaEm: null,
                contatoId: null,
                messageId: null
            }
        });
        console.log(`${id}: desfeita (${mensagem.nomeAluno || mensagem.matricula})`);
    }
}

(async () => {
    const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
    try {
        if (ids.length) await reverter(ids);
        else await listar();
    } finally {
        await prisma.$disconnect();
    }
})();
