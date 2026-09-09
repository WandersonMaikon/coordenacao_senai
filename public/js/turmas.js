// Helpers de turma compartilhados pelas telas do painel.
// Carregado via <script src="/js/turmas.js"> antes do script inline da página.

// O SGE repete o curso na coluna "série", então o nome montado pelo userscript
// chega como "Curso - Curso - Turno". Remove partes consecutivas iguais só na
// exibição — o dado no banco continua como veio do SGE.
function nomeTurmaLimpo(nome) {
  if (!nome) return nome;
  const partes = nome.split(' - ').map((parte) => parte.trim()).filter(Boolean);
  return partes
    .filter((parte, i) => i === 0 || parte.toLowerCase() !== partes[i - 1].toLowerCase())
    .join(' - ');
}

// Preenche um <select> com as turmas de GET /turmas, mantendo a primeira opção
// (o "Todas as turmas" que cada tela já traz no HTML).
async function preencherSelectTurmas(select, chamarApi) {
  try {
    const resposta = await chamarApi('/turmas');
    resposta.dados.forEach((turma) => {
      const opcao = document.createElement('option');
      opcao.value = turma.codigoTurma;
      opcao.textContent = turma.nomeTurma
        ? `${nomeTurmaLimpo(turma.nomeTurma)} (${turma.codigoTurma})`
        : turma.codigoTurma;
      select.appendChild(opcao);
    });
  } catch (erro) {
    console.error('Não foi possível carregar a lista de turmas:', erro);
  }
}
