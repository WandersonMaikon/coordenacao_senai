-- CreateTable
CREATE TABLE `instalacoes_script` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `instalacao_id` VARCHAR(64) NOT NULL,
    `professor` VARCHAR(255) NOT NULL DEFAULT '',
    `versao` VARCHAR(20) NOT NULL DEFAULT '',
    `navegador` VARCHAR(30) NOT NULL DEFAULT '',
    `ultimo_sinal_em` DATETIME(3) NOT NULL,
    `ultimo_envio_em` DATETIME(3) NULL,
    `fila_pendente` INTEGER NOT NULL DEFAULT 0,
    `fila_desde` DATETIME(3) NULL,
    `ultima_captura_em` DATETIME(3) NULL,
    `tela_captura` VARCHAR(200) NULL,
    `sem_captura_em` DATETIME(3) NULL,
    `sem_captura_tela` VARCHAR(200) NULL,
    `criado_em` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `atualizado_em` DATETIME(3) NOT NULL,

    UNIQUE INDEX `instalacoes_script_instalacao_id_key`(`instalacao_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
