-- A chave de idempotência do lançamento passa a incluir a UC.
--
-- Antes, a chave era (matricula, data_aula, codigo_turma). Quando dois professores
-- lançavam frequência da mesma turma no mesmo dia (UCs diferentes), o segundo envio
-- caía na mesma chave e SOBRESCREVIA a falta lançada pelo primeiro — inclusive
-- zerando-a quando o aluno estava presente na outra UC. Com a UC na chave, cada
-- professor tem sua própria linha e a soma do dia é feita na leitura.

-- uc entra na chave única, então não pode ser NULL: em MySQL, NULLs não colidem
-- entre si num índice único e a idempotência deixaria de valer para essas linhas.
UPDATE `lancamentos` SET `uc` = '' WHERE `uc` IS NULL;

-- DropIndex
DROP INDEX `lancamentos_matricula_data_aula_codigo_turma_key` ON `lancamentos`;

-- AlterTable
ALTER TABLE `lancamentos` MODIFY `uc` VARCHAR(255) NOT NULL DEFAULT '';

-- CreateIndex
CREATE UNIQUE INDEX `lancamentos_matricula_data_aula_codigo_turma_uc_key` ON `lancamentos`(`matricula`, `data_aula`, `codigo_turma`, `uc`);
