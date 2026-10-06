-- Multiempresa — passo 0/2.
-- Isolado numa migration própria: o Postgres não permite usar um valor de
-- enum recém-adicionado dentro da mesma transação em que foi criado, e o
-- passo 1 já converte respostas rápidas GLOBAL existentes para COMPANY.
ALTER TYPE "QuickReplyScope" ADD VALUE IF NOT EXISTS 'COMPANY';
