-- 2ª mensagem automática por episódio de risco: a chave única passa a incluir a
-- tentativa. O índice novo é criado antes de o antigo sair, pra tabela nunca
-- ficar sem a garantia de unicidade.
ALTER TABLE `mensagens_whatsapp` ADD COLUMN `tentativa` INTEGER NOT NULL DEFAULT 1;

CREATE UNIQUE INDEX `mensagens_whatsapp_matricula_codigo_turma_primeira_falta_ten_key` ON `mensagens_whatsapp`(`matricula`, `codigo_turma`, `primeira_falta`, `tentativa`);

DROP INDEX `mensagens_whatsapp_matricula_codigo_turma_primeira_falta_key` ON `mensagens_whatsapp`;
