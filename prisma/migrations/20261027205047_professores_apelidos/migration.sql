-- CreateTable
CREATE TABLE `professores_apelidos` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `chave` VARCHAR(255) NOT NULL,
    `chave_destino` VARCHAR(255) NOT NULL,
    `criado_por` VARCHAR(50) NOT NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `professores_apelidos_chave_key`(`chave`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
