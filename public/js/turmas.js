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
  ativarBuscaDeTurma(select);
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

// ───────────── Busca de turma (autocomplete) ─────────────
//
// Troca o <select> de turma por um campo onde se digita parte do nome ou do
// código ("bolos", "noturno", "APR-OPC"). O <select> continua na página,
// escondido, como a fonte da verdade: as telas seguem lendo e escrevendo
// `select.value` como antes (inclusive o `value = ''` dos botões "Limpar"), e a
// escolha dispara o mesmo evento `change`. Campo vazio = "Todas".
// Ativada sozinha pelo preencherSelectTurmas — nenhuma tela precisa chamar.

function semAcento(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function ativarBuscaDeTurma(select) {
  if (!select || select.dataset.buscaTurma) return;
  select.dataset.buscaTurma = '1';

  const pequeno = select.classList.contains('form-select-sm');
  const caixa = document.createElement('div');
  caixa.className = 'position-relative';
  // Largura fixa: a maioria das telas põe o filtro numa coluna `col-auto`, que
  // encolhe até o conteúdo — e campo de texto vazio é estreito (o <select> antigo
  // era largo por causa dos nomes das turmas). No celular, cabe na tela.
  caixa.style.width = pequeno ? 'min(24rem, calc(100vw - 3rem))' : 'min(36rem, calc(100vw - 3rem))';
  const campo = document.createElement('input');
  campo.type = 'text';
  campo.className = `form-control pe-5${pequeno ? ' form-control-sm' : ''}`;
  campo.placeholder = 'Todas — digite o nome ou o código da turma';
  campo.autocomplete = 'off';
  campo.id = `${select.id}Busca`;
  campo.setAttribute('role', 'combobox');
  campo.setAttribute('aria-expanded', 'false');
  const limpar = document.createElement('button');
  limpar.type = 'button';
  limpar.className = 'btn btn-sm btn-link text-body-secondary position-absolute top-50 end-0 translate-middle-y';
  limpar.title = 'Mostrar todas as turmas';
  limpar.innerHTML = '<i class="bi bi-x-lg"></i>';
  limpar.hidden = true;
  const lista = document.createElement('ul');
  lista.className = 'dropdown-menu w-100 shadow-sm';
  lista.style.maxHeight = '320px';
  lista.style.overflowY = 'auto';
  lista.setAttribute('role', 'listbox');

  select.hidden = true;
  select.after(caixa);
  caixa.append(campo, limpar, lista);
  const rotulo = document.querySelector(`label[for="${select.id}"]`);
  if (rotulo) rotulo.htmlFor = campo.id;

  // As opções do <select> (menos a primeira, "Todas") viram a lista de busca.
  const opcoes = () => [...select.options].slice(1).map((o) => ({ valor: o.value, texto: o.textContent }));
  let visiveis = [];
  let destacada = -1;

  function textoDaSelecionada() {
    const opcao = select.selectedIndex > 0 ? select.options[select.selectedIndex] : null;
    return opcao ? opcao.textContent : '';
  }

  // Mostra no campo o que está escolhido no <select>.
  function sincronizar() {
    campo.value = textoDaSelecionada();
    limpar.hidden = !campo.value;
  }

  function fechar() {
    lista.classList.remove('show');
    campo.setAttribute('aria-expanded', 'false');
    destacada = -1;
  }

  function desenhar() {
    const palavras = semAcento(campo.value).split(/\s+/).filter(Boolean);
    // Campo mostrando a turma já escolhida: abre a lista inteira, não só ela.
    const filtrar = palavras.length && campo.value !== textoDaSelecionada();
    visiveis = opcoes().filter((o) => !filtrar || palavras.every((p) => semAcento(o.texto).includes(p)));
    lista.innerHTML = visiveis.length
      ? visiveis.slice(0, 80).map((o, i) => {
          // "Nome (CÓDIGO) — encerrada": o código vai embaixo, menor.
          const casou = o.texto.match(/^(.*) \(([^)]+)\)(.*)$/);
          const nome = casou ? casou[1] : o.texto;
          const resto = casou ? `${casou[2]}${casou[3]}` : '';
          return `<li><button type="button" class="dropdown-item text-wrap${i === destacada ? ' active' : ''}" data-indice="${i}" role="option">
            <div>${escaparTurma(nome)}</div>${resto ? `<div class="small opacity-75">${escaparTurma(resto)}</div>` : ''}</button></li>`;
        }).join('')
      : '<li><span class="dropdown-item-text small text-body-secondary">Nenhuma turma com esse nome ou código.</span></li>';
    lista.classList.add('show');
    campo.setAttribute('aria-expanded', 'true');
  }

  function escolher(valor) {
    valorNativo.set.call(select, valor);
    sincronizar();
    fechar();
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }

  campo.addEventListener('focus', () => { campo.select(); desenhar(); });
  campo.addEventListener('input', () => { destacada = visiveis.length ? 0 : -1; desenhar(); limpar.hidden = !campo.value; });
  campo.addEventListener('keydown', (evento) => {
    if (evento.key === 'ArrowDown' || evento.key === 'ArrowUp') {
      evento.preventDefault();
      if (!lista.classList.contains('show')) desenhar();
      const total = Math.min(visiveis.length, 80);
      if (!total) return;
      destacada = evento.key === 'ArrowDown' ? (destacada + 1) % total : (destacada - 1 + total) % total;
      desenhar();
      lista.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    } else if (evento.key === 'Enter') {
      // Enter escolhe a turma destacada; com o campo vazio, volta para "Todas".
      // Não deixa o Enter enviar o formulário com o texto pela metade.
      if (lista.classList.contains('show')) {
        evento.preventDefault();
        if (!campo.value.trim()) escolher('');
        else if (destacada >= 0 && visiveis[destacada]) escolher(visiveis[destacada].valor);
        else if (visiveis.length === 1) escolher(visiveis[0].valor);
      }
    } else if (evento.key === 'Escape') {
      sincronizar();
      fechar();
    }
  });
  // mousedown (e não click): acontece antes do blur do campo fechar a lista.
  lista.addEventListener('mousedown', (evento) => {
    const item = evento.target.closest('[data-indice]');
    if (!item) return;
    evento.preventDefault();
    escolher(visiveis[Number(item.dataset.indice)].valor);
  });
  campo.addEventListener('blur', () => {
    // Apagou tudo = "Todas"; texto que não virou escolha volta ao que estava.
    if (!campo.value.trim() && select.value) escolher('');
    else sincronizar();
    fechar();
  });
  limpar.addEventListener('click', () => { escolher(''); campo.focus(); });

  // `select.value = ...` feito pela tela (botão "Limpar", troca de "incluir
  // encerradas") também atualiza o campo.
  const valorNativo = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(select, 'value', {
    configurable: true,
    get() { return valorNativo.get.call(this); },
    set(valor) { valorNativo.set.call(this, valor); sincronizar(); }
  });
  // Opções recarregadas (preencherSelectTurmas de novo): o texto acompanha.
  new MutationObserver(sincronizar).observe(select, { childList: true });
  sincronizar();
}

function escaparTurma(texto) {
  return String(texto ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
