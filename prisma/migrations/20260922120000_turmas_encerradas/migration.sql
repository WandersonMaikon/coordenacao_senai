-- CreateTable
CREATE TABLE `turmas_encerradas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `codigo_turma` VARCHAR(50) NOT NULL,
    `nome_turma` VARCHAR(255) NULL,
    `motivo` VARCHAR(50) NULL,
    `observacao` TEXT NULL,
    `encerrada_por` VARCHAR(255) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `turmas_encerradas_codigo_turma_key`(`codigo_turma`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
