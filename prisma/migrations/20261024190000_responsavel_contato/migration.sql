-- CreateTable
CREATE TABLE `responsaveis_contato` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `matricula` VARCHAR(20) NOT NULL,
    `usuario` VARCHAR(50) NOT NULL,
    `assumido_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `responsaveis_contato_matricula_key`(`matricula`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
