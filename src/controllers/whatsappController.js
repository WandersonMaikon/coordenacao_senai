const prisma = require('../config/prisma');
const openwa = require('../services/openwa');
const whatsappLote = require('../services/whatsappLote');
const whatsappEnvio = require('../services/whatsappEnvio');
const { normalizarTelefone, mesmoTelefone } = require('../services/telefone');
const whatsappAutomatico = require('../services/whatsappAutomatico');

const TIPOS_NUMERO = ['pessoal', 'institucional'];
const { STATUS_PRECISA_ACAO, MOTIVO_NUMERO_DIFERENTE } = whatsappEnvio;

async function buscarUsuario(req) {
    return prisma.usuario.findUnique({ where: { usuario: req.usuario.usuario }, select: { id: true, usuario: true, nome: true } });
}

async function buscarOuCriarSessao(usuarioId) {
    return prisma.whatsappSessao.upsert({ where: { usuarioId }, update: {}, create: { usuarioId } });
}

function respostaErro(res, erro) {
    // Sem esta linha, uma falha ao conectar aparecia na tela e em lugar nenhum do
    // log — e é no log que se descobre se o problema era o OpenWA travado.
    console.error('[whatsapp] erro na rota:', erro.message);
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

// Eventos que o backend trata (ver src/services/whatsappResposta.js): a resposta
// do aluno, a confirmação de entrega/leitura e a falha reportada pelo WhatsApp
// (`message.failed` vem ADEMAIS do ack, não em vez dele — sem assinar este
// evento, número que não recebe mais mensagem fica parado em "enviada").
const EVENTOS_WEBHOOK = ['message.received', 'message.ack', 'message.failed'];

// Garante que a sessão tem o webhook de entrada registrado no OpenWA. Roda a
// cada conexão, não só na criação: as sessões que já existem hoje foram criadas
// antes da etapa 4 e não têm webhook nenhum — sem isso elas nunca receberiam
// resposta.
//
// Falha aqui não quebra o conectar: o envio continua funcionando sem o webhook,
// só não volta resposta. Mas NÃO é silenciosa — devolve `aviso` pra tela mostrar.
// Já aconteceu de o registro ser recusado (o OpenWA valida a URL contra a
// proteção SSRF no momento do registro) e ninguém perceber por semanas: as
// mensagens saíam, as respostas dos alunos eram descartadas e a tela dizia que
// estava tudo conectado. Aviso na cara de quem conecta é o que evita repetir isso.
async function garantirWebhook(sessionId) {
    const url = process.env.OPENWA_WEBHOOK_URL;
    if (!sessionId) return { ok: false, aviso: null };
    if (!url) {
        return { ok: false, aviso: 'O servidor está sem OPENWA_WEBHOOK_URL: as mensagens saem, mas a resposta dos alunos não volta pro sistema.' };
    }
    if (!process.env.OPENWA_WEBHOOK_SECRET) {
        // Sem o segredo o middleware do /webhook/whatsapp responde 503 em todo
        // evento — registrar o webhook não adiantaria nada.
        return { ok: false, aviso: 'O servidor está sem OPENWA_WEBHOOK_SECRET: a resposta dos alunos é recusada ao chegar. Rode "bash scripts/configurar-whatsapp.sh" no servidor.' };
    }

    try {
        const atuais = await openwa.listarWebhooks(sessionId);
        const lista = Array.isArray(atuais) ? atuais : (atuais?.data || atuais?.webhooks || []);
        if (lista.some((item) => item?.url === url)) return { ok: true, aviso: null };

        await openwa.registrarWebhook(sessionId, {
            url,
            eventos: EVENTOS_WEBHOOK,
            segredo: process.env.OPENWA_WEBHOOK_SECRET
        });
        console.log('[whatsapp] webhook de entrada registrado na sessão', sessionId);
        return { ok: true, aviso: null };
    } catch (erro) {
        console.warn('[whatsapp] não foi possível registrar o webhook de entrada:', erro.message);
        // 400 no registro é quase sempre a proteção SSRF recusando a URL interna
        // — o conserto é no servidor, não aqui, então a mensagem diz qual é.
        const aviso = erro.status === 400
            ? `O OpenWA recusou o endereço de retorno (${url}). Libere o host interno no container openwa_retencao (SSRF_ALLOWED_HOSTS) — enquanto isso as respostas dos alunos não chegam.`
            : `Não foi possível registrar o retorno das respostas no OpenWA: ${erro.message}. As mensagens saem, mas a resposta dos alunos não volta pro sistema.`;
        return { ok: false, aviso };
    }
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
        if (trocouNumero && sessao.envioAutomatico) {
            return res.status(409).json({ status: 'erro', mensagem: 'Este é o número do envio automático. Desligue o envio automático antes de trocar o número.' });
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
            // Sessão perdida numa tentativa anterior (criação que passou do tempo
            // limite, desconexão que não terminou) sai antes de criar outra.
            await whatsappEnvio.limparSessoesOrfas().catch((erro) => console.warn('[whatsapp] limpeza de sessões:', erro.message));
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

        const webhook = await garantirWebhook(sessao.sessionId);

        res.json({ status: 'ok', dados: dadosNumero(sessao), avisoWebhook: webhook.aviso });
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

        // Confere o retorno das respostas só quando o número já está pronto: é o
        // único estado em que faz sentido, e a tela para de consultar a cada 3s
        // aqui, então isso não vira uma chamada por segundo no OpenWA. Conferir
        // (e não só registrar no conectar) é o que faz a tela avisar também nas
        // sessões que já estavam conectadas de antes.
        let avisoWebhook = null;
        if (remota.status === 'ready') {
            avisoWebhook = (await garantirWebhook(sessao.sessionId)).aviso;
        }

        res.json({ status: 'ok', configurado: true, dados: dadosNumero(sessao), qrCode, erroSessao: remota.lastError || null, avisoWebhook });
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

// ───────────── Envio automático ─────────────

// Quem pode mexer na chave e nas turmas do número do sistema: o dono do número
// (normalmente o usuário do chip, ex: "whatsapp-1") ou o administrador.
function podeAlterarSistema(req, usuario, sistema) {
    return Boolean(req.usuario.admin) || sistema.usuarioId === usuario.id;
}

function validarTurmas(turmas) {
    if (turmas === null || turmas === undefined) return { turmas: null };
    if (!Array.isArray(turmas) || turmas.some((t) => typeof t !== 'string' || !t.trim())) {
        return { erro: 'Lista de turmas inválida.' };
    }
    const lista = [...new Set(turmas.map((t) => t.trim()))];
    if (lista.length === 0) return { erro: 'Escolha pelo menos uma turma, ou "Todas as turmas".' };
    return { turmas: lista };
}

// GET /whatsapp/automatico — estado do número do sistema e a cobertura: quantos
// alunos em risco já receberam, estão na fila, ou não podem receber (e por quê).
// Visível a todos os usuários logados; só o dono e o admin alteram.
async function obterAutomatico(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });
        const agora = new Date();
        const [minhaSessao, sistema] = await Promise.all([
            buscarOuCriarSessao(usuario.id),
            whatsappAutomatico.sessaoDoSistema()
        ]);

        const base = {
            status: 'ok',
            agora,
            admin: Boolean(req.usuario.admin),
            situacoes: whatsappAutomatico.SITUACOES,
            diasRecente: whatsappAutomatico.DIAS_RECENTE,
            minhaSessao: {
                conectado: minhaSessao.status === 'ready' && Boolean(minhaSessao.sessionId),
                institucional: minhaSessao.tipo === 'institucional',
                pausadoMotivo: minhaSessao.pausadoMotivo
            }
        };
        if (!sistema) return res.json({ ...base, sistema: null });

        const lote = await whatsappAutomatico.loteAutomatico(sistema.id)
            || await prisma.loteWhatsapp.findFirst({ where: { sessaoId: sistema.id, automatico: true }, orderBy: { id: 'desc' } });

        const [uso, itens, mensagens, proxima] = await Promise.all([
            whatsappEnvio.contarEnvios(sistema.id, agora),
            whatsappAutomatico.avaliar(sistema, agora),
            lote
                ? prisma.mensagemWhatsapp.findMany({
                    where: { loteId: lote.id },
                    orderBy: { atualizadoEm: 'desc' },
                    take: 30,
                    select: { id: true, nomeAluno: true, codigoTurma: true, nomeTurma: true, status: true, erro: true, enviadaEm: true, atualizadoEm: true }
                })
                : [],
            lote
                ? prisma.mensagemWhatsapp.findFirst({
                    where: { loteId: lote.id, status: { in: ['enviando', 'pendente'] } },
                    orderBy: [{ status: 'asc' }, { id: 'asc' }], // "enviando" antes de "pendente"
                    select: { nomeAluno: true, status: true }
                })
                : null
        ]);

        // Quem não recebe e por quê — é a pergunta "por que a Maria não recebeu?".
        const SEM_ENVIO = ['contato_humano', 'sair', 'sem_whatsapp', 'sem_telefone', 'situacao', 'antigo'];
        const naoRecebem = itens
            .filter((item) => SEM_ENVIO.includes(item.situacao))
            .map((item) => ({
                nomeAluno: item.nomeAluno,
                codigoTurma: item.codigoTurma,
                nomeTurma: item.nomeTurma,
                diasSemVir: item.diasSemVir,
                situacao: item.situacao
            }));

        res.json({
            ...base,
            sistema: {
                dono: sistema.usuario.nome || sistema.usuario.usuario,
                souDono: sistema.usuarioId === usuario.id,
                podeAlterar: podeAlterarSistema(req, usuario, sistema),
                telefone: sistema.telefone,
                conectado: sistema.status === 'ready' && Boolean(sistema.sessionId),
                pausadoMotivo: sistema.pausadoMotivo,
                turmas: whatsappAutomatico.lerTurmas(sistema)
            },
            uso: { hoje: uso.hoje, limiteDia: whatsappLote.limiteDiaEfetivo(sistema, agora), mes: uso.mes, limiteMes: sistema.limiteMes },
            lote: lote ? { status: lote.status, aguardando: lote.aguardando, proximoEnvioEm: lote.proximoEnvioEm } : null,
            proxima,
            resumo: whatsappAutomatico.resumir(itens),
            naoRecebem,
            mensagens
        });
    } catch (erro) {
        respostaErro(res, erro);
    }
}

// PUT /whatsapp/automatico { ligado, turmas: ["codigo", ...] | null }
// Ligar sem número do sistema torna o número do PRÓPRIO usuário o do sistema —
// e só chip da escola pode: um bloqueio no número pessoal tira o WhatsApp da
// pessoa inteiro. Só um número fica ligado por vez.
async function salvarAutomatico(req, res) {
    try {
        const usuario = await buscarUsuario(req);
        if (!usuario) return res.status(404).json({ status: 'erro', mensagem: 'Usuário não encontrado' });

        const ligado = req.body.ligado === true;
        const { turmas, erro } = validarTurmas(req.body.turmas);
        if (erro) return res.status(400).json({ status: 'erro', mensagem: erro });

        const sistema = await whatsappAutomatico.sessaoDoSistema();
        if (sistema && !podeAlterarSistema(req, usuario, sistema)) {
            const dono = sistema.usuario.nome || sistema.usuario.usuario;
            return res.status(403).json({ status: 'erro', mensagem: `O número do sistema é o de ${dono}. Só essa pessoa ou o administrador podem alterar o envio automático.` });
        }

        if (!ligado) {
            if (!sistema) return res.json({ status: 'ok', mensagem: 'O envio automático já estava desligado.' });
            await prisma.whatsappSessao.update({ where: { id: sistema.id }, data: { envioAutomatico: false } });
            const lote = await whatsappAutomatico.loteAutomatico(sistema.id);
            if (lote) await whatsappEnvio.pararLote(lote, usuario.usuario);
            return res.json({ status: 'ok', mensagem: 'Envio automático desligado. Quem estava na fila não recebe.' });
        }

        let alvo = sistema;
        if (!alvo) {
            const minha = await buscarOuCriarSessao(usuario.id);
            if (minha.tipo !== 'institucional') {
                return res.status(400).json({ status: 'erro', mensagem: 'O envio automático só pode usar um chip da escola. Cadastre o número como "Chip da escola" na aba Meu número.' });
            }
            if (!minha.sessionId || minha.status !== 'ready') {
                return res.status(400).json({ status: 'erro', mensagem: 'Conecte o WhatsApp (aba Meu número) antes de ligar o envio automático.' });
            }
            if (minha.pausadoMotivo) {
                return res.status(400).json({ status: 'erro', mensagem: `O envio por este número está pausado: ${minha.pausadoMotivo} Resolva e clique em Retomar.` });
            }
            alvo = minha;
        }

        const atualizada = await prisma.whatsappSessao.update({
            where: { id: alvo.id },
            data: { envioAutomatico: true, turmasAutomatico: turmas ? JSON.stringify(turmas) : null },
            include: { usuario: true }
        });

        // Abastece já, sem esperar a próxima conferência do worker: quem ligou quer
        // ver a fila. Mensagem de turma que saiu do piloto é cancelada pelo worker.
        let entraram = 0;
        try {
            entraram = await whatsappAutomatico.abastecer(atualizada);
        } catch (erroAbastecer) {
            console.error('[whatsapp] erro ao abastecer ao ligar o envio automático:', erroAbastecer.message);
        }
        const fila = entraram ? ` ${entraram} aluno(s) entraram na fila.` : '';
        res.json({ status: 'ok', mensagem: `${sistema ? 'Envio automático atualizado.' : 'Envio automático ligado.'}${fila}` });
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
    obterAutomatico,
    salvarAutomatico,
    retomarSessao,
    historico,
    obterMeuNumero,
    salvarMeuNumero,
    conectarSessao,
    obterSessao,
    desconectarSessao,
    obterConfig,
    salvarConfig,
    previaMensagem,
    normalizarTelefone,
    mesmoTelefone
};
