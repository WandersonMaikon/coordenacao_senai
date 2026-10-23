-- CreateTable
CREATE TABLE `faltas_coletivas` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `codigo_turma` VARCHAR(50) NOT NULL,
    `data_aula` VARCHAR(20) NOT NULL,
    `decisao` VARCHAR(20) NOT NULL,
    `decidido_por` VARCHAR(50) NOT NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `faltas_coletivas_codigo_turma_data_aula_key`(`codigo_turma`, `data_aula`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

