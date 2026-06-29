// ==UserScript==
// @name         SGE Novo - Captura Frequência SENAI
// @namespace    http://tampermonkey.net/
// @version      3.4
// @description  Captura frequência do novo SGE (Angular/PO-UI) - resposta otimista, envio rápido, suporta correção, envia só o que mudou
// @author       Wanderson
// @match        https://sge.fiero.org.br/*
// @match        http://sge.fiero.org.br/*
// @include      *sge.fiero.org.br*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ==========================================
    // CONFIGURAÇÃO — cada professor edita aqui
    // ==========================================
    const NOME_PROFESSOR = 'Wanderson Maikon da Silva';
    const WEBHOOK_URL = 'http://localhost:3000/webhook/frequencia';
    // ==========================================

    const MAX_TENTATIVAS = 3;
    const DELAY_RETRY_MS = 3000;      // reduzido de 5s para 3s
    const TIMEOUT_MS = 7000;          // reduzido de 15s para 7s
    const CHAVE_FILA = 'sge_fila_pendente_v3';
    const CHAVE_CACHE_ESTADO = 'sge_cache_estado_v1';

    console.log('%c[SGE-v3.4] Script carregado (resposta otimista, com suporte a correção, envia só o que mudou)', 'color: green; font-weight: bold;');

    // ─────────────────────────────────────────
    // FILA LOCAL
    // ─────────────────────────────────────────

    function lerFila() {
        try { return JSON.parse(GM_getValue(CHAVE_FILA, '[]')); }
        catch (e) { return []; }
    }
    function salvarFila(fila) { GM_setValue(CHAVE_FILA, JSON.stringify(fila)); }
    function adicionarNaFila(payload) {
        const fila = lerFila();
        fila.push({ payload, adicionadoEm: new Date().toISOString() });
        salvarFila(fila);
    }
    function limparFila() { salvarFila([]); }

    // ─────────────────────────────────────────
    // CACHE LOCAL DO ÚLTIMO ESTADO ENVIADO
    // ─────────────────────────────────────────
    // Guarda, por matricula+data_aula+codigo_turma, o último qtd_faltas que
    // foi CONFIRMADO pelo servidor. Serve para comparar com a tela atual e
    // mandar só o que mudou (faltas novas ou correções), em vez de mandar
    // o estado de presença de todo mundo a cada clique em "Salvar".

    function chaveItem(item) {
        return `${item.matricula}|${item.data_aula}|${item.codigo_turma}`;
    }
    function lerCacheEstado() {
        try { return JSON.parse(GM_getValue(CHAVE_CACHE_ESTADO, '{}')); }
        catch (e) { return {}; }
    }
    function salvarCacheEstado(cache) { GM_setValue(CHAVE_CACHE_ESTADO, JSON.stringify(cache)); }
    function atualizarCacheEstado(itensConfirmados) {
        const cache = lerCacheEstado();
        itensConfirmados.forEach(item => { cache[chaveItem(item)] = item.qtd_faltas; });
        salvarCacheEstado(cache);
    }

    // Compara o estado completo da tela com o cache e devolve só os
    // registros que mudaram desde o último envio confirmado:
    // - nunca enviado antes E tem falta marcada (>0)  -> falta nova
    // - já enviado antes E o valor é diferente do cache -> correção
    function calcularDelta(estadoCompleto) {
        const cache = lerCacheEstado();
        return estadoCompleto.filter(item => {
            const valorCache = cache[chaveItem(item)];
            if (valorCache === undefined) return item.qtd_faltas > 0;
            return item.qtd_faltas !== valorCache;
        });
    }

    // ─────────────────────────────────────────
    // INFO DA TURMA
    // ─────────────────────────────────────────

    function extrairInfoTurma() {
        const info = {
            periodoLetivo: '', curso: '', serie: '',
            codigoTurma: '', disciplina: '', turno: '', tipo: ''
        };

        const tabelas = document.querySelectorAll('table.po-table');

        for (const tabela of tabelas) {
            if (tabela.querySelector('tr.tr-data')) continue;

            const linhaCabecalho = tabela.querySelector('tbody tr');
            if (!linhaCabecalho) continue;

            const celulas = linhaCabecalho.querySelectorAll('td .po-table-column-cell');
            if (celulas.length < 7) continue;

            info.periodoLetivo = celulas[0]?.innerText.trim() || '';
            info.curso = celulas[1]?.innerText.trim() || '';
            info.serie = celulas[2]?.innerText.trim() || '';
            info.codigoTurma = (celulas[3]?.innerText || '').replace(/[^\w\-]/g, ' ').trim().split(/\s+/).pop() || '';
            info.disciplina = celulas[4]?.innerText.trim() || '';
            info.turno = celulas[5]?.innerText.trim() || '';
            info.tipo = celulas[6]?.innerText.trim() || '';

            break;
        }

        return info;
    }

    // ─────────────────────────────────────────
    // CAPTURA
    // ─────────────────────────────────────────

    // Lê o estado de TODAS as colunas de aula de cada aluno na tela, marcadas
    // ou não (qtd_faltas pode ser 0). É a "fonte da verdade" no momento do
    // clique — depois passa por calcularDelta() para decidir o que de fato
    // precisa ser enviado (ver seção CACHE LOCAL acima).
    function capturarEstadoCompleto() {
        const linhas = document.querySelectorAll('tr.tr-data');
        if (linhas.length === 0) {
            console.warn('[SGE-v3.4] Nenhuma linha de aluno encontrada.');
            return null;
        }

        const infoTurma = extrairInfoTurma();
        const lancamentos = [];

        linhas.forEach(linha => {
            const raCelula = linha.querySelector('td[data-cy="ra"] .column-values');
            const matricula = raCelula ? raCelula.innerText.trim() : '';

            const nomeCelula = linha.querySelector('td[data-cy="name"] .column-values');
            const nomeAluno = nomeCelula ? nomeCelula.innerText.trim() : '';

            if (!matricula) return;

            const celulasData = linha.querySelectorAll('td[data-cy^="x"]');

            // Agrupa por data (pode haver mais de uma aula no mesmo dia),
            // sempre registrando a data mesmo com 0 faltas marcadas.
            const porData = {};

            celulasData.forEach(celula => {
                const dataAulaRaw = celula.getAttribute('data-cy');
                const switchEl = celula.querySelector('[role="switch"]');
                if (!switchEl) return;

                const marcado = switchEl.getAttribute('aria-checked') === 'true';
                const dataLimpa = dataAulaRaw.replace(/^x/, '').replace(/c\d+$/, '');

                if (!porData[dataLimpa]) {
                    porData[dataLimpa] = { idAula: dataAulaRaw, qtdFaltas: 0 };
                }
                if (marcado) porData[dataLimpa].qtdFaltas += 1;
            });

            Object.entries(porData).forEach(([dataLimpa, info]) => {
                lancamentos.push({
                    matricula,
                    nome_aluno: nomeAluno,
                    data_aula: dataLimpa,
                    id_aula: info.idAula,
                    codigo_turma: infoTurma.codigoTurma,
                    nome_turma: `${infoTurma.curso} - ${infoTurma.serie} - ${infoTurma.turno}`.trim(),
                    uc: infoTurma.disciplina,
                    periodo_letivo: infoTurma.periodoLetivo,
                    professor: NOME_PROFESSOR,
                    qtd_faltas: info.qtdFaltas
                });
            });
        });

        return lancamentos.length > 0 ? lancamentos : null;
    }

    // Função usada de fato pelo clique em "Salvar": captura tudo, mas só
    // devolve o que mudou desde o último envio confirmado.
    function capturarMudancas() {
        const estadoCompleto = capturarEstadoCompleto();
        if (!estadoCompleto) return null;

        const delta = calcularDelta(estadoCompleto);
        return delta.length > 0 ? delta : null;
    }

    // ─────────────────────────────────────────
    // ENVIO — AGORA COM RESPOSTA OTIMISTA
    // ─────────────────────────────────────────

    // Dispara o envio e AVISA O PROFESSOR IMEDIATAMENTE.
    // O sucesso/falha real só aparece silenciosamente no console,
    // e só vira notificação visível se TODAS as tentativas falharem.
    function enviarOtimista(lancamentos) {
        // 1. Mostra sucesso JÁ, sem esperar o servidor
        notificar('✅ Frequência registrada!', false);
        console.log('[SGE-v3.4] Envio disparado em background para', lancamentos.length, 'registro(s).');

        // 2. Envia de verdade em paralelo, com retry silencioso
        enviarComRetry(lancamentos, 1);
    }

    function enviarComRetry(lancamentos, tentativa) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: WEBHOOK_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ lancamentos }),
            timeout: TIMEOUT_MS,

            onload: function (res) {
                try {
                    const json = JSON.parse(res.responseText);
                    if (json.status === 'ok') {
                        console.log('%c[SGE-v3.4] ✅ Confirmado pelo servidor: ' + json.mensagem, 'color:green');
                        atualizarCacheEstado(lancamentos);
                        limparFila();
                    } else {
                        tentarNovamenteSilencioso(lancamentos, tentativa, 'Erro: ' + json.mensagem);
                    }
                } catch (e) {
                    if (res.status >= 200 && res.status < 400) {
                        console.log('[SGE-v3.4] ✅ Confirmado (resposta não-JSON, status OK)');
                        atualizarCacheEstado(lancamentos);
                        limparFila();
                    } else {
                        tentarNovamenteSilencioso(lancamentos, tentativa, 'Status ' + res.status);
                    }
                }
            },
            onerror: () => tentarNovamenteSilencioso(lancamentos, tentativa, 'Erro de rede'),
            ontimeout: () => tentarNovamenteSilencioso(lancamentos, tentativa, 'Timeout'),
            onabort: () => console.warn('[SGE-v3.4] Conexão abortada (provavelmente navegação de página).')
        });
    }

    // Retry SILENCIOSO — não perturba o professor com novas notificações.
    // Só se TUDO falhar é que avisamos (e mesmo assim os dados não se perdem).
    function tentarNovamenteSilencioso(lancamentos, tentativaAtual, motivo) {
        console.warn('[SGE-v3.4] Tentativa', tentativaAtual, 'falhou (silencioso):', motivo);

        if (tentativaAtual < MAX_TENTATIVAS) {
            setTimeout(() => enviarComRetry(lancamentos, tentativaAtual + 1), DELAY_RETRY_MS);
        } else {
            console.error('[SGE-v3.4] ❌ Todas as tentativas falharam. Salvando na fila local.');
            adicionarNaFila(lancamentos);
            // Só agora avisamos visualmente — é uma falha real que precisa de atenção
            notificar('⚠️ Falha ao confirmar envio. Será reenviado automaticamente.', true);
        }
    }

    function processarFilaPendente() {
        const fila = lerFila();
        if (fila.length === 0) return;

        console.log('[SGE-v3.4] Reenviando', fila.length, 'pendente(s) em background...');
        const item = fila[0];

        enviarComRetryParaFila(item.payload, 1, function (sucesso) {
            if (sucesso) {
                const atual = lerFila();
                atual.shift();
                salvarFila(atual);
                if (atual.length > 0) setTimeout(processarFilaPendente, 2000);
            }
        });
    }

    // Versão da função de envio usada apenas para reprocessar a fila
    // (precisa de callback para saber quando remover da fila)
    function enviarComRetryParaFila(lancamentos, tentativa, callback) {
        GM_xmlhttpRequest({
            method: 'POST',
            url: WEBHOOK_URL,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ lancamentos }),
            timeout: TIMEOUT_MS,
            onload: function (res) {
                try {
                    const json = JSON.parse(res.responseText);
                    if (json.status === 'ok') {
                        console.log('[SGE-v3.4] ✅ Pendente confirmado.');
                        atualizarCacheEstado(lancamentos);
                        callback(true);
                    } else if (tentativa < MAX_TENTATIVAS) {
                        setTimeout(() => enviarComRetryParaFila(lancamentos, tentativa + 1, callback), DELAY_RETRY_MS);
                    } else {
                        callback(false);
                    }
                } catch (e) {
                    if (res.status >= 200 && res.status < 400) {
                        atualizarCacheEstado(lancamentos);
                        callback(true);
                    } else if (tentativa < MAX_TENTATIVAS) {
                        setTimeout(() => enviarComRetryParaFila(lancamentos, tentativa + 1, callback), DELAY_RETRY_MS);
                    } else {
                        callback(false);
                    }
                }
            },
            onerror: () => {
                if (tentativa < MAX_TENTATIVAS) setTimeout(() => enviarComRetryParaFila(lancamentos, tentativa + 1, callback), DELAY_RETRY_MS);
                else callback(false);
            },
            ontimeout: () => {
                if (tentativa < MAX_TENTATIVAS) setTimeout(() => enviarComRetryParaFila(lancamentos, tentativa + 1, callback), DELAY_RETRY_MS);
                else callback(false);
            }
        });
    }

    // ─────────────────────────────────────────
    // NOTIFICAÇÃO VISUAL
    // ─────────────────────────────────────────

    function notificar(mensagem, erro) {
        const anterior = document.getElementById('sge-notif-v3');
        if (anterior) anterior.remove();

        const div = document.createElement('div');
        div.id = 'sge-notif-v3';
        div.innerText = mensagem;
        div.style.cssText = `
            position: fixed; top: 20px; right: 20px;
            background: ${erro ? '#d93025' : '#1a73e8'};
            color: white; padding: 12px 20px; border-radius: 8px;
            font-size: 14px; font-family: Arial, sans-serif;
            z-index: 999999; box-shadow: 0 4px 12px rgba(0,0,0,0.3);
            transition: opacity 0.5s; max-width: 320px;
        `;
        document.body.appendChild(div);
        setTimeout(() => {
            div.style.opacity = '0';
            setTimeout(() => div.remove(), 500);
        }, erro ? 8000 : 2500); // sucesso desaparece mais rápido agora
    }

    // ─────────────────────────────────────────
    // INTERCEPTADOR DO BOTÃO SALVAR
    // ─────────────────────────────────────────

    function instalarInterceptador() {
        let botaoSalvar = null;

        document.querySelectorAll('button, po-button, [class*="po-button"]').forEach(btn => {
            const texto = (btn.innerText || btn.textContent || '').trim();
            if (texto === 'Salvar') botaoSalvar = btn;
        });

        if (botaoSalvar) {
            console.log('[SGE-v3.4] Botão Salvar encontrado.');
            botaoSalvar.addEventListener('click', function () {
                // Captura é instantânea (leitura de DOM), não precisa de delay artificial
                const mudancas = capturarMudancas();
                if (!mudancas) {
                    console.log('[SGE-v3.4] Nenhuma mudança de frequência detectada (nada a enviar).');
                    return;
                }
                console.log('[SGE-v3.4] Detectada(s)', mudancas.length, 'mudança(s) (faltas novas + correções). Enviando...');
                enviarOtimista(mudancas);
            }, true);
        } else {
            setTimeout(instalarInterceptador, 2000);
        }
    }

    // ─────────────────────────────────────────
    // INICIALIZAÇÃO
    // ─────────────────────────────────────────

    setTimeout(processarFilaPendente, 3000);
    setTimeout(instalarInterceptador, 1500);

    window.testarCapturaSGE = function () {
        const mudancas = capturarMudancas();
        if (!mudancas) {
            console.warn('[SGE-v3.4] Nenhuma mudança de frequência detectada.');
            return;
        }
        console.log('[SGE-v3.4] Mudanças a enviar:', mudancas);
        console.table(mudancas);
        enviarOtimista(mudancas);
    };

    window.verEstadoCompletoSGE = function () {
        const estado = capturarEstadoCompleto();
        console.log('[SGE-v3.4] Estado completo da tela (antes do diff):', estado);
        if (estado) console.table(estado);
    };

    window.verInfoTurmaSGE = function () {
        console.log('[SGE-v3.4] Info da turma:', extrairInfoTurma());
    };

    window.verFilaSGE = function () {
        console.log('[SGE-v3.4] Fila:', lerFila());
    };

    window.limparFilaSGE = function () {
        limparFila();
        console.log('[SGE-v3.4] Fila limpa.');
    };

    window.verCacheEstadoSGE = function () {
        console.log('[SGE-v3.4] Cache de estado (último confirmado pelo servidor):', lerCacheEstado());
    };

    window.limparCacheEstadoSGE = function () {
        salvarCacheEstado({});
        console.log('[SGE-v3.4] Cache de estado limpo — próximo "Salvar" vai reenviar tudo que estiver marcado na tela.');
    };

})();
