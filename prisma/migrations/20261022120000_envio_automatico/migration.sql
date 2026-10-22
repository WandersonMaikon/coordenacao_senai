-- AlterTable: número do sistema (envio automático) e turmas do piloto
ALTER TABLE `whatsapp_sessoes` ADD COLUMN `envio_automatico` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `turmas_automatico` TEXT NULL;

-- AlterTable: lote permanente do envio automático
ALTER TABLE `lotes_whatsapp` ADD COLUMN `automatico` BOOLEAN NOT NULL DEFAULT false;
