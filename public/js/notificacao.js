// Aviso de "deu certo / não deu" depois de gravar, apagar ou corrigir alguma
// coisa. É um toast (canto superior direito, some sozinho) e não um Swal.fire
// normal de propósito: o painel é usado com o telefone na mão, e uma caixa no
// meio da tela pedindo "OK" a cada contato registrado atrapalharia mais do que
// ajuda. As confirmações de "tem certeza?" continuam sendo Swal.fire normal —
// essas o usuário precisa mesmo parar e ler.
//
// As mensagens inline que já existiam nas telas (o "Contato registrado." ao
// lado do botão) continuam: elas ficam na tela, o toast só chama a atenção.
(function () {
  const toast = Swal.mixin({
    toast: true,
    position: 'top-end',
    showConfirmButton: false,
    timer: 3000,
    timerProgressBar: true,
    // Sem roubar o foco: o usuário costuma já estar digitando o próximo campo.
    focusConfirm: false,
    didOpen: (elemento) => {
      elemento.addEventListener('mouseenter', Swal.stopTimer);
      elemento.addEventListener('mouseleave', Swal.resumeTimer);
    }
  });

  window.notificar = {
    ok(mensagem) {
      toast.fire({ icon: 'success', title: mensagem });
    },
    // Erro fica mais tempo na tela: quem falhou precisa ler o motivo.
    erro(mensagem) {
      toast.fire({ icon: 'error', title: mensagem || 'Não foi possível concluir.', timer: 6000 });
    }
  };
})();
