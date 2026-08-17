function paginaLogin(req, res) {
    res.render('auth/login');
}

function paginaPainel(req, res) {
    res.render('painel');
}

function paginaFaltas(req, res) {
    res.render('faltas');
}

function paginaImportarTelefones(req, res) {
    res.render('importar-telefones');
}

module.exports = { paginaLogin, paginaPainel, paginaFaltas, paginaImportarTelefones };