require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/authRoutes');
const lancamentoRoutes = require('./src/routes/lancamentoRoutes');
const turmaRoutes = require('./src/routes/turmaRoutes');
const alunoRoutes = require('./src/routes/alunoRoutes');
const contatoRoutes = require('./src/routes/contatoRoutes');
const usuarioRoutes = require('./src/routes/usuarioRoutes');
const viewRoutes = require('./src/routes/viewRoutes');
const userscriptRoutes = require('./src/routes/userscriptRoutes');
const whatsappRoutes = require('./src/routes/whatsappRoutes');
const whatsappWebhookRoutes = require('./src/routes/whatsappWebhookRoutes');
const professorRoutes = require('./src/routes/professorRoutes');
const prisma = require('./src/config/prisma');
const { iniciarWorker: iniciarWorkerWhatsapp } = require('./src/services/whatsappEnvio');
const { garantirModelo: garantirModeloIa } = require('./src/services/iaLocal');
const { retomarConversasPendentes } = require('./src/services/whatsappResposta');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

// Os dados de faltas mudam a cada lançamento — sem isso, o navegador cacheia
// a resposta JSON via ETag e pode devolver 304 (corpo vazio) pro fetch().
app.disable('etag');

app.use(cors());
app.use(express.json({
    limit: '5mb',
    // O webhook do WhatsApp valida assinatura HMAC sobre os bytes exatos que
    // chegaram — depois do JSON.parse não dá mais pra reconstruir o corpo byte a
    // byte (espaços, ordem das chaves). Guardamos o cru só nessa rota.
    verify: (req, res, buf) => {
        if (req.url.startsWith('/webhook/whatsapp')) req.corpoCru = buf;
    }
}));

// index: false — GET '/' é o redirecionamento pro login abaixo, não uma index.html
app.use(express.static(PUBLIC_DIR, { index: false }));

// Versão dos arquivos do painel (/js, /css), trocada a cada subida do servidor —
// ou seja, a cada deploy. As views usam `?v=<%= versaoArquivos %>`: o Cloudflare
// manda o navegador guardar .js/.css por 4 horas, e sem isto a tela nova ficava
// com o script velho (visto em 24/10/2026: o filtro de turma novo não aparecia
// para ninguém até um Ctrl+F5).
app.locals.versaoArquivos = Date.now().toString(36);

// A raiz do domínio é a porta de entrada do painel: quem acessa
// app.coor360-senai.com.br cai direto na tela de login.
app.get('/', (req, res) => {
    res.redirect('/login');
});

// Healthcheck (antes era o GET '/') — usado pra conferir se o backend e o
// banco estão de pé sem precisar abrir o painel.
app.get('/health', (req, res) => {
    res.json({ status: 'ok', mensagem: 'Backend SENAI Ji-Paraná ativo (Node + Prisma + MySQL)' });
});

app.use(viewRoutes);
app.use(userscriptRoutes);
app.use('/auth', authRoutes);
app.use('/auth', usuarioRoutes);
app.use(lancamentoRoutes);
app.use(turmaRoutes);
app.use(alunoRoutes);
app.use(contatoRoutes);
app.use(whatsappRoutes);
app.use(whatsappWebhookRoutes);
app.use(professorRoutes);

app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Teste a conexão em: http://localhost:${PORT}/health`);
    console.log(`🔑 Login em: http://localhost:${PORT}/auth/login`);
    console.log(`📋 Veja os lançamentos em: http://localhost:${PORT}/lancamentos`);
    console.log(`⚠️  Veja alunos em risco em: http://localhost:${PORT}/alunos-risco`);
    console.log(`🧩 Userscript dos professores em: http://localhost:${PORT}/sge-captura.user.js`);
    // Envio de WhatsApp em lote (tela /whatsapp) — só liga se o OpenWA estiver configurado.
    iniciarWorkerWhatsapp();
    // IA local que lê as respostas dos alunos: baixa o modelo na primeira vez
    // (sem travar a subida; enquanto isso vale o dicionário).
    garantirModeloIa();
    // Respostas de aluno que esperavam o robô responder quando o servidor reiniciou.
    retomarConversasPendentes().catch((erro) => console.error('[whatsapp] não foi possível retomar conversas pendentes:', erro.message));
});

// Encerra a conexão do Prisma corretamente quando o servidor for finalizado
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});
