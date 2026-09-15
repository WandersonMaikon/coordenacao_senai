const prisma = require('../config/prisma');
const openwa = require('../services/openwa');
const whatsappLote = require('../services/whatsappLote');
const whatsappEnvio = require('../services/whatsappEnvio');
const { normalizarTelefone, mesmoTelefone } = require('../services/telefone');
const { calcularAlunosEmRiscoSemRecuperados } = require('./alunoController');

const TIPOS_NUMERO = ['pessoal', 'institucional'];
const { STATUS_PRECISA_ACAO, MOTIVO_NUMERO_DIFERENTE } = whatsappEnvio;

async function buscarUsuario(req) {
    return prisma.usuario.findUnique({ where: { usuario: req.usuario.usuario }, select: { id: true, usuario: true, nome: true } });
}

async function buscarOuCriarSessao(usuarioId) {
    return prisma.whatsappSessao.upsert({ where: { usuarioId }, update: {}, create: { usuarioId } });
}

function respostaErro(res, erro) {
    if (erro instanceof openwa.ErroOpenWA) {
        return res.status(erro.status === 503 || erro.status === null ? 503 : 502).json({ status: 'erro', mensagem: erro.message });
    }
    return res.status(500).json({ status: 'erro', mensagem: erro.message });
}

function dadosNumero(sessao) {
    return {
        telefone: sessao.telefone,
        tipo: sessao.tipo,
        telefoneConectado: sessao.telefoneConectado,
        status: sessao.status,
        conectadoEm: sessao.conectadoEm,
        pausadoMotivo: sessao.pausadoMotivo,
        temSessao: Boolean(sessao.sessionId),
        numeroConfere: sessao.telefoneConectado ? mesmoTelefone(sessao.telefone, sessao.telefoneConectado) : null
    };
}

// Encerra a sessão no OpenWA sem deixar um erro dele travar a troca de número:
// se o OpenWA estiver fora do ar, a sessão antiga fica órfã lá, mas o cadastro
// aqui segue — e ela não recebe mais envio nenhum, porque perdemos o id.
async function encerrarSessaoOpenWA(sessionId) {
    if (!sessionId) return;
    try { await openwa.desconectarSessao(sessionId); } catch (erro) { console.warn('OpenWA logout:', erro.message); }
    try { await openwa.apagarSessao(sessionId); } catch (erro) { console.warn('OpenWA delete:', erro.message); }
}

// GET /whatsapp/meu-numero
async function obterMeuNumero(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);
        res.json({ status: 'ok', configurado: openwa.configurado(), dados: dadosNumero(sessao) });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// PUT /whatsapp/meu-numero — cadastra ou troca o número. Trocar desconecta o
// número antigo: senão o celular velho continuaria enviando em nome do novo.
async function salvarMeuNumero(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const telefone = normalizarTelefone(req.body.telefone);
        const tipo = req.body.tipo;
        if (telefone.length < 10 || telefone.length > 11) {
            return res.status(400).json({ status: 'erro', mensagem: 'Informe o número com DDD, ex: (69) 99340-8643' });
        }
        if (!TIPOS_NUMERO.includes(tipo)) {
            return res.status(400).json({ status: 'erro', mensagem: 'Tipo deve ser pessoal ou institucional' });
        }

        const sessao = await buscarOuCriarSessao(usuario.id);
        const trocouNumero = sessao.telefone && sessao.telefone !== telefone;

        // Trocar no meio de um envio mandaria o resto do lote de outro celular,
        // assinado com um contato que o aluno não conhece.
        if (trocouNumero && await whatsappEnvio.loteEmAndamento(sessao.id)) {
            return res.status(409).json({ status: 'erro', mensagem: 'Há um envio em andamento. Pare o envio antes de trocar o número.' });
        }

        if (trocouNumero) await encerrarSessaoOpenWA(sessao.sessionId);

        const atualizada = await prisma.whatsappSessao.update({
            where: { id: sessao.id },
            data: {
                telefone,
                tipo,
                ...(trocouNumero ? { sessionId: null, telefoneConectado: null, status: null, conectadoEm: null, pausadoMotivo: null } : {})
            }
        });

        res.json({
            status: 'ok',
            mensagem: trocouNumero ? 'Número trocado. Conecte o novo número lendo o QR code.' : 'Número salvo.',
            dados: dadosNumero(atualizada)
        });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// POST /whatsapp/sessao/conectar — cria a sessão no OpenWA (se ainda não tem) e
// inicia; o QR sai no GET /whatsapp/sessao, que a tela consulta em seguida.
async function conectarSessao(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        let sessao = await buscarOuCriarSessao(usuario.id);
        if (!sessao.telefone) {
            return res.status(400).json({ status: 'erro', mensagem: 'Cadastre o seu número antes de conectar.' });
        }

        if (!sessao.sessionId) {
            const criada = await openwa.criarSessao(`coor360-${usuario.usuario}-${usuario.id}`);
            sessao = await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { sessionId: criada.id, status: criada.status } });
        }

        try {
            const iniciada = await openwa.iniciarSessao(sessao.sessionId);
            sessao = await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { status: iniciada.status } });
        } catch (erro) {
            // 400 = "já iniciada/iniciando": segue pro status normalmente.
            // 404 = a sessão sumiu do OpenWA (volume apagado): cria de novo no próximo clique.
            if (erro.status === 404) {
                await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { sessionId: null, status: null } });
                return res.status(409).json({ status: 'erro', mensagem: 'A sessão antiga não existe mais no servidor. Clique em conectar de novo.' });
            }
            if (erro.status !== 400) throw erro;
        }

        res.json({ status: 'ok', dados: dadosNumero(sessao) });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// GET /whatsapp/sessao — status atual direto do OpenWA (atualiza o cache) e o QR
// quando está esperando leitura. A tela consulta a cada 3s enquanto conecta.
async function obterSessao(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        let sessao = await buscarOuCriarSessao(usuario.id);
        if (!sessao.sessionId) {
            return res.json({ status: 'ok', configurado: openwa.configurado(), dados: dadosNumero(sessao), qrCode: null });
        }

        let remota;
        try {
            remota = await openwa.obterSessao(sessao.sessionId);
        } catch (erro) {
            if (erro.status === 404) {
                sessao = await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { sessionId: null, status: null, telefoneConectado: null } });
                return res.json({ status: 'ok', configurado: true, dados: dadosNumero(sessao), qrCode: null });
            }
            throw erro;
        }

        const dados = { status: remota.status };
        if (remota.phone) dados.telefoneConectado = String(remota.phone);
        if (remota.status === 'ready' && !sessao.conectadoEm) dados.conectadoEm = new Date();

        // Pausa de proteção: número conectado diferente do cadastrado, ou número
        // caiu. Não tira a pausa sozinho — quem retoma é o usuário (etapa do envio).
        // A exceção é o número diferente: conectou o celular certo, o problema acabou.
        if (remota.status === 'ready' && remota.phone && !mesmoTelefone(sessao.telefone, remota.phone)) {
            dados.pausadoMotivo = MOTIVO_NUMERO_DIFERENTE;
        } else if (remota.status === 'ready' && sessao.pausadoMotivo === MOTIVO_NUMERO_DIFERENTE) {
            dados.pausadoMotivo = null;
        } else if (STATUS_PRECISA_ACAO.includes(remota.status) && !sessao.pausadoMotivo) {
            dados.pausadoMotivo = 'O WhatsApp foi desconectado. Conecte o número de novo.';
        }

        sessao = await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: dados });

        let qrCode = null;
        if (remota.status === 'qr_ready') {
            try {
                qrCode = (await openwa.obterQr(sessao.sessionId)).qrCode;
            } catch (erro) {
                // QR expira e é regenerado — entre um e outro o OpenWA devolve 400.
                if (erro.status !== 400) throw erro;
            }
        }

        res.json({ status: 'ok', configurado: true, dados: dadosNumero(sessao), qrCode, erroSessao: remota.lastError || null });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// POST /whatsapp/sessao/desconectar — desliga o WhatsApp do servidor (o celular
// perde o "aparelho conectado"). O número cadastrado continua salvo.
async function desconectarSessao(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const sessao = await buscarOuCriarSessao(usuario.id);
        await encerrarSessaoOpenWA(sessao.sessionId);
        const atualizada = await prisma.whatsappSessao.update({
            where: { id: sessao.id },
            data: {
                sessionId: null,
                status: null,
                telefoneConectado: null,
                ...(sessao.pausadoMotivo === MOTIVO_NUMERO_DIFERENTE ? { pausadoMotivo: null } : {})
            }
        });
        res.json({ status: 'ok', mensagem: 'WhatsApp desconectado.', dados: dadosNumero(atualizada) });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// ───────────── Turmas ─────────────

// GET /whatsapp/turmas — todas as turmas com chamada lançada, quem é o responsável
// (null = disponível) e quantos alunos estão em risco agora, pra ajudar a escolher.
async function listarTurmas(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const [turmas, assumidas, { emRisco }] = await Promise.all([
            prisma.lancamento.findMany({
                where: { codigoTurma: { not: null } },
                distinct: ['codigoTurma'],
                select: { codigoTurma: true, nomeTurma: true },
                orderBy: { codigoTurma: 'asc' }
            }),
            prisma.usuarioTurma.findMany({ include: { usuario: { select: { id: true, usuario: true, nome: true } } } }),
            calcularAlunosEmRiscoSemRecuperados()
        ]);

        const responsavelPorTurma = new Map(assumidas.map((a) => [a.codigoTurma, a]));
        const riscoPorTurma = new Map();
        for (const item of emRisco) riscoPorTurma.set(item.codigoTurma, (riscoPorTurma.get(item.codigoTurma) || 0) + 1);

        const dados = turmas.map((turma) => {
            const assumida = responsavelPorTurma.get(turma.codigoTurma);
            return {
                codigoTurma: turma.codigoTurma,
                nomeTurma: turma.nomeTurma,
                emRisco: riscoPorTurma.get(turma.codigoTurma) || 0,
                responsavel: assumida ? { usuario: assumida.usuario.usuario, nome: assumida.usuario.nome } : null,
                minha: assumida ? assumida.usuarioId === usuario.id : false,
                assumidaEm: assumida ? assumida.criadoEm : null
            };
        });

        res.json({ status: 'ok', admin: Boolean(req.usuario.admin), dados });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// POST /whatsapp/turmas/:codigoTurma — assumir. Quem garante "um responsável por
// turma" é o índice único: se duas pessoas clicarem juntas, a segunda cai no P2002.
async function assumirTurma(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const { codigoTurma } = req.params;
        const existe = await prisma.lancamento.findFirst({ where: { codigoTurma }, select: { id: true } });
        if (!existe) return res.status(404).json({ status: 'erro', mensagem: 'Turma não encontrada' });

        try {
            await prisma.usuarioTurma.create({ data: { usuarioId: usuario.id, codigoTurma } });
        } catch (erro) {
            if (erro.code !== 'P2002') throw erro;
            const atual = await prisma.usuarioTurma.findUnique({ where: { codigoTurma }, include: { usuario: { select: { usuario: true, nome: true } } } });
            const quem = atual?.usuarioId === usuario.id ? 'você' : (atual?.usuario.nome || atual?.usuario.usuario || 'outro usuário');
            return res.status(409).json({ status: 'erro', mensagem: `Esta turma já está com ${quem}.` });
        }
        res.json({ status: 'ok', mensagem: 'Turma assumida.' });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// DELETE /whatsapp/turmas/:codigoTurma — liberar. Só o responsável ou o admin
// (pro caso de alguém sair da coordenação com turmas presas no nome dele).
// Na etapa 3 isto também cancela as mensagens pendentes da turma.
async function liberarTurma(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const atual = await prisma.usuarioTurma.findUnique({ where: { codigoTurma: req.params.codigoTurma } });
        if (!atual) return res.status(404).json({ status: 'erro', mensagem: 'Esta turma não está com ninguém.' });
        if (atual.usuarioId !== usuario.id && !req.usuario.admin) {
            return res.status(403).json({ status: 'erro', mensagem: 'Só quem assumiu a turma (ou o administrador) pode liberá-la.' });
        }

        await prisma.usuarioTurma.delete({ where: { id: atual.id } });
        // Quem ainda estava na fila por causa desta turma não recebe mais por este número.
        const canceladas = await prisma.mensagemWhatsapp.updateMany({
            where: { codigoTurma: atual.codigoTurma, usuarioId: atual.usuarioId, status: 'pendente' },
            data: { status: 'cancelada', erro: `Turma liberada por ${usuario.usuario}` }
        });
        res.json({
            status: 'ok',
            mensagem: canceladas.count ? `Turma liberada. ${canceladas.count} mensagem(ns) na fila foram canceladas.` : 'Turma liberada.'
        });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// ───────────── Mensagem e limites ─────────────

function dadosConfig(sessao) {
    return {
        mensagemModelo: sessao.mensagemModelo || whatsappLote.MENSAGEM_PADRAO,
        usandoMensagemPadrao: !sessao.mensagemModelo,
        intervaloMinSeg: sessao.intervaloMinSeg,
        intervaloMaxSeg: sessao.intervaloMaxSeg,
        limiteDia: sessao.limiteDia,
        limiteMes: sessao.limiteMes,
        janelaInicio: sessao.janelaInicio,
        janelaFim: sessao.janelaFim,
        limiteDiaEfetivo: whatsappLote.limiteDiaEfetivo(sessao),
        emAquecimento: whatsappLote.limiteDiaEfetivo(sessao) < sessao.limiteDia
    };
}

// GET /whatsapp/config
async function obterConfig(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);
        res.json({
            status: 'ok',
            dados: dadosConfig(sessao),
            mensagemPadrao: whatsappLote.MENSAGEM_PADRAO,
            tetos: whatsappLote.TETOS,
            aquecimento: whatsappLote.AQUECIMENTO,
            variaveis: whatsappLote.VARIAVEIS,
            menu: whatsappLote.blocoMenu()
        });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// PUT /whatsapp/config
async function salvarConfig(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const { dados, erro } = whatsappLote.validarConfig(req.body);
        if (erro) return res.status(400).json({ status: 'erro', mensagem: erro });

        const sessao = await buscarOuCriarSessao(usuario.id);
        // Mensagem igual à padrão fica null: se o texto padrão melhorar um dia,
        // quem nunca personalizou recebe a versão nova.
        if (dados.mensagemModelo === whatsappLote.MENSAGEM_PADRAO) dados.mensagemModelo = null;

        const atualizada = await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: dados });
        res.json({ status: 'ok', mensagem: 'Configuração salva.', dados: dadosConfig(atualizada) });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// POST /whatsapp/config/previa — como a mensagem fica pra um aluno de exemplo,
// com o texto que ainda está no campo (antes de salvar).
async function previaMensagem(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const texto = whatsappLote.renderizarMensagem(String(req.body.mensagemModelo || ''), {
            nomeAluno: 'MARIA DA SILVA',
            nomeTurma: 'Operador de Computador - Operador de Computador - Matutino',
            diasSemVir: 2,
            responsavel: whatsappLote.nomeResponsavel(usuario)
        });
        res.json({ status: 'ok', texto });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// GET /whatsapp/lote/previa?incluirSemResposta=1&incluirNaoContatado=1 — quem
// receberia mensagem se o envio fosse iniciado agora. Não envia nada (etapa 3).
async function previaLote(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);
        const previa = await whatsappLote.montarPrevia(usuario, sessao, opcoesDoPedido(req.query));
        res.json({ status: 'ok', ...previa, limiteDiaEfetivo: whatsappLote.limiteDiaEfetivo(sessao) });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// ───────────── Envio ─────────────

function opcoesDoPedido(fonte) {
    return {
        incluirSemResposta: fonte.incluirSemResposta === '1' || fonte.incluirSemResposta === true,
        incluirNaoContatado: fonte.incluirNaoContatado === '1' || fonte.incluirNaoContatado === true
    };
}

// POST /whatsapp/lote { incluirSemResposta, incluirNaoContatado, excluidos: ["matricula|codigoTurma"] }
async function iniciarEnvio(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);

        if (!sessao.sessionId || sessao.status !== 'ready') {
            return res.status(400).json({ status: 'erro', mensagem: 'Conecte o seu WhatsApp (aba Meu número) antes de iniciar o envio.' });
        }
        if (sessao.pausadoMotivo) {
            return res.status(400).json({ status: 'erro', mensagem: `O envio por este número está pausado: ${sessao.pausadoMotivo} Resolva e clique em Retomar.` });
        }

        const excluidos = Array.isArray(req.body.excluidos) ? req.body.excluidos.map(String) : [];
        const lote = await whatsappLote.iniciarLote(usuario, sessao, opcoesDoPedido(req.body), excluidos);
        res.json({ status: 'ok', mensagem: `Envio iniciado para ${lote.total} aluno(s).`, loteId: lote.id });
    } catch (erro) {
        if (erro instanceof whatsappLote.ErroLote) return res.status(erro.status).json({ status: 'erro', mensagem: erro.message });
        respostaErro(res, erro);
    }
}

// GET /whatsapp/lote/atual — o lote em andamento (ou o último) com o status de cada
// mensagem, uso do dia/mês e quando sai a próxima. A tela consulta a cada 5s.
async function loteAtual(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);
        const agora = new Date();

        const lote = await whatsappEnvio.loteEmAndamento(sessao.id)
            || await prisma.loteWhatsapp.findFirst({ where: { sessaoId: sessao.id }, orderBy: { id: 'desc' } });

        const uso = await whatsappEnvio.contarEnvios(sessao.id, agora);
        const base = {
            status: 'ok',
            agora,
            sessao: { conectado: sessao.status === 'ready' && Boolean(sessao.sessionId), status: sessao.status, pausadoMotivo: sessao.pausadoMotivo },
            uso: { hoje: uso.hoje, limiteDia: whatsappLote.limiteDiaEfetivo(sessao, agora), mes: uso.mes, limiteMes: sessao.limiteMes }
        };
        if (!lote) return res.json({ ...base, lote: null, mensagens: [], contagem: {} });

        const mensagens = await prisma.mensagemWhatsapp.findMany({
            where: { loteId: lote.id },
            orderBy: { id: 'asc' },
            select: { id: true, matricula: true, nomeAluno: true, codigoTurma: true, nomeTurma: true, status: true, erro: true, enviadaEm: true, telefone: true }
        });
        const contagem = { pendente: 0, enviando: 0, enviada: 0, falhou: 0, cancelada: 0 };
        for (const m of mensagens) {
            const chave = whatsappEnvio.STATUS_JA_RECEBEU.includes(m.status) ? 'enviada' : m.status;
            contagem[chave] = (contagem[chave] || 0) + 1;
        }
        const proxima = mensagens.find((m) => m.status === 'enviando') || mensagens.find((m) => m.status === 'pendente') || null;

        res.json({ ...base, lote, mensagens, contagem, proxima: proxima ? { nomeAluno: proxima.nomeAluno, status: proxima.status } : null });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// POST /whatsapp/lote/:id/parar
async function pararEnvio(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);

        const lote = await prisma.loteWhatsapp.findFirst({ where: { id: Number(req.params.id), sessaoId: sessao.id } });
        if (!lote) return res.status(404).json({ status: 'erro', mensagem: 'Envio não encontrado' });
        if (lote.status !== 'em_andamento') return res.status(409).json({ status: 'erro', mensagem: 'Este envio já terminou.' });

        await whatsappEnvio.pararLote(lote, usuario.usuario);
        res.json({ status: 'ok', mensagem: 'Envio parado. Os alunos que ainda não receberam voltam a aparecer no próximo envio.' });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// POST /whatsapp/sessao/retomar — tira a pausa de proteção. Se o problema
// continuar (celular desconectado, número diferente), o worker pausa de novo na
// próxima rodada, com o motivo atualizado.
async function retomarSessao(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const sessao = await buscarOuCriarSessao(usuario.id);
        await prisma.whatsappSessao.update({ where: { id: sessao.id }, data: { pausadoMotivo: null, falhasSeguidas: 0 } });
        res.json({ status: 'ok', mensagem: 'Envio retomado.' });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// GET /whatsapp/mensagens?turma=&usuario=&status=&pagina= — histórico de TODOS os
// envios, visível a qualquer usuário logado: quem mandou, de qual número, pra quem.
async function historico(req, res) {
    try {
        const POR_PAGINA = 50;
        const pagina = Math.max(1, Number(req.query.pagina) || 1);
        const where = {};
        if (req.query.turma) where.codigoTurma = req.query.turma;
        if (req.query.usuario) where.usuarioId = Number(req.query.usuario);
        if (req.query.status) {
            where.status = req.query.status === 'enviada' ? { in: whatsappEnvio.STATUS_JA_RECEBEU } : req.query.status;
        }

        const [total, mensagens, usuarios, sessoes] = await Promise.all([
            prisma.mensagemWhatsapp.count({ where }),
            prisma.mensagemWhatsapp.findMany({
                where,
                orderBy: { atualizadoEm: 'desc' },
                skip: (pagina - 1) * POR_PAGINA,
                take: POR_PAGINA,
                select: { id: true, loteId: true, usuarioId: true, sessaoId: true, matricula: true, nomeAluno: true, codigoTurma: true, nomeTurma: true, status: true, erro: true, enviadaEm: true, criadoEm: true, atualizadoEm: true }
            }),
            prisma.usuario.findMany({ select: { id: true, usuario: true, nome: true } }),
            prisma.whatsappSessao.findMany({ select: { id: true, telefone: true, tipo: true } })
        ]);

        const usuarioPorId = new Map(usuarios.map((u) => [u.id, u]));
        const sessaoPorId = new Map(sessoes.map((s) => [s.id, s]));
        const dados = mensagens.map((m) => ({
            ...m,
            enviadoPor: usuarioPorId.get(m.usuarioId)?.nome || usuarioPorId.get(m.usuarioId)?.usuario || '—',
            numero: sessaoPorId.get(m.sessaoId)?.telefone || null,
            tipoNumero: sessaoPorId.get(m.sessaoId)?.tipo || null
        }));

        res.json({
            status: 'ok',
            total,
            pagina,
            paginas: Math.max(1, Math.ceil(total / POR_PAGINA)),
            dados,
            usuarios: usuarios.map((u) => ({ id: u.id, nome: u.nome || u.usuario }))
        });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

module.exports = {
    iniciarEnvio,
    loteAtual,
    pararEnvio,
    retomarSessao,
    historico,
    obterMeuNumero,
    salvarMeuNumero,
    conectarSessao,
    obterSessao,
    desconectarSessao,
    listarTurmas,
    assumirTurma,
    liberarTurma,
    obterConfig,
    salvarConfig,
    previaMensagem,
    previaLote,
    normalizarTelefone,
    mesmoTelefone
};
