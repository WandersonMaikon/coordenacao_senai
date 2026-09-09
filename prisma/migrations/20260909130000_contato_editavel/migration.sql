-- O histórico de contatos passou a ser editável pela tela de Alunos em risco
-- (PUT /contatos/:id). criadoEm continua sendo a data do contato em si;
-- atualizado_em registra quando a coordenação corrigiu o lançamento.
-- Linhas já existentes recebem CURRENT_TIMESTAMP: nunca foram editadas, então
-- ficam com atualizado_em >= criado_em sem significar correção.

-- AlterTable
ALTER TABLE `contatos` ADD COLUMN `atualizado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);
