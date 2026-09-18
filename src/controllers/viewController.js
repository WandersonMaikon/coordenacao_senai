const { MOTIVOS } = require('../config/motivos');

function paginaLogin(req, res) {
    res.render('auth/login');
}

function paginaPainel(req, res) {
    res.render('painel');
}

function paginaFaltas(req, res) {
    res.render('faltas');
}

function paginaRisco(req, res) {
    res.render('risco');
}

function paginaRecuperado(req, res) {
    // A lista de motivos vai do servidor pra view: é a mesma de src/config/motivos.js
    // usada no menu do WhatsApp, então não vira uma segunda cópia pra manter.
    res.render('recuperado', { motivos: MOTIVOS });
}

function paginaWhatsapp(req, res) {
    res.render('whatsapp');
}

function paginaImportarTelefones(req, res) {
    res.render('importar-telefones');
}

function paginaUsuarios(req, res) {
    res.render('usuarios');
}

module.exports = { paginaLogin, paginaPainel, paginaFaltas, paginaRisco, paginaRecuperado, paginaWhatsapp, paginaImportarTelefones, paginaUsuarios };