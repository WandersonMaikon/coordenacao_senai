/*
  Warnings:

  - You are about to drop the `professores_apelidos` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropTable
DROP TABLE `professores_apelidos`;

-- CreateTable
CREATE TABLE `correcoes_nome_professor` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `nome_digitado` VARCHAR(255) NOT NULL,
    `nome_correto` VARCHAR(255) NOT NULL,
    `corrigido_por` VARCHAR(50) NOT NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `correcoes_nome_professor_nome_digitado_key`(`nome_digitado`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
