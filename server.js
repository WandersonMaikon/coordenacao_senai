require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');

const authRoutes = require('./src/routes/authRoutes');
const lancamentoRoutes = require('./src/routes/lancamentoRoutes');
const alunoRoutes = require('./src/routes/alunoRoutes');
const contatoRoutes = require('./src/routes/contatoRoutes');
const usuarioRoutes = require('./src/routes/usuarioRoutes');
const viewRoutes = require('./src/routes/viewRoutes');
const userscriptRoutes = require('./src/routes/userscriptRoutes');
const prisma = require('./src/config/prisma');

const app = express();
const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src/views'));

// Os dados de faltas mudam a cada lançamento — sem isso, o navegador cacheia
// a resposta JSON via ETag e pode devolver 304 (corpo vazio) pro fetch().
app.disable('etag');

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// index: false — GET '/' é o redirecionamento pro login abaixo, não uma index.html
app.use(express.static(PUBLIC_DIR, { index: false }));

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
app.use(alunoRoutes);
app.use(contatoRoutes);

app.listen(PORT, () => {
    console.log(`✅ Servidor rodando em http://localhost:${PORT}`);
    console.log(`📊 Teste a conexão em: http://localhost:${PORT}/health`);
    console.log(`🔑 Login em: http://localhost:${PORT}/auth/login`);
    console.log(`📋 Veja os lançamentos em: http://localhost:${PORT}/lancamentos`);
    console.log(`⚠️  Veja alunos em risco em: http://localhost:${PORT}/alunos-risco`);
    console.log(`🧩 Userscript dos professores em: http://localhost:${PORT}/sge-captura.user.js`);
});

// Encerra a conexão do Prisma corretamente quando o servidor for finalizado
process.on('SIGINT', async () => {
    await prisma.$disconnect();
    process.exit(0);
});
