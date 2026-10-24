-- AlterTable
ALTER TABLE `mensagens_whatsapp` ADD COLUMN `conversa_etapa` VARCHAR(30) NULL,
    ADD COLUMN `conversa_turnos` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `conversa_pediu_texto` BOOLEAN NOT NULL DEFAULT false;
