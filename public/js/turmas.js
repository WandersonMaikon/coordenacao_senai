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
// Turma encerrada só entra com `incluirEncerradas` — é o checkbox das telas.
// Como pode ser chamada de novo quando o checkbox muda, limpa as opções que ela
// mesma criou antes (tudo menos a primeira).
async function preencherSelectTurmas(select, chamarApi, incluirEncerradas) {
  try {
    const resposta = await chamarApi(incluirEncerradas ? '/turmas?incluirEncerradas=1' : '/turmas');
    const selecionada = select.value;
    while (select.options.length > 1) select.remove(1);
    resposta.dados.forEach((turma) => {
      const opcao = document.createElement('option');
      opcao.value = turma.codigoTurma;
      const nome = turma.nomeTurma
        ? `${nomeTurmaLimpo(turma.nomeTurma)} (${turma.codigoTurma})`
        : turma.codigoTurma;
      opcao.textContent = turma.encerrada ? `${nome} — encerrada` : nome;
      select.appendChild(opcao);
    });
    // Se a turma escolhida ainda está na lista, mantém a seleção (desmarcar
    // "incluir encerradas" com uma turma encerrada escolhida volta pra "todas").
    select.value = [...select.options].some((o) => o.value === selecionada) ? selecionada : select.options[0].value;
  } catch (erro) {
    console.error('Não foi possível carregar a lista de turmas:', erro);
  }
}
