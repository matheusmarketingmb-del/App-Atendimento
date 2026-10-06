// Read only KnowledgeSource from an existing backup into a NEW, isolated reference database.
// Never restore Conversations, Messages, credentials or production databases.
const { execFileSync } = require("node:child_process");
const container = "mibro-bot-qa-20261005b";
const database = "bot_knowledge_reference_20261005";
const dump = "/tmp/reference-knowledge-20261005.dump";
const docker = (args) => execFileSync("docker", ["exec", container, ...args], { encoding: "utf8" });
const sql = (db, query) => docker(["psql", "-U", "bot_qa", "-d", db, "-v", "ON_ERROR_STOP=1", "-At", "-c", query]);
if (!sql("bot_qa", `SELECT 1 FROM pg_database WHERE datname = '${database}'`).trim()) sql("bot_qa", `CREATE DATABASE ${database}`);
if (!sql(database, `SELECT to_regclass('public."KnowledgeSource"')`).trim()) {
  sql(database, `CREATE TYPE "KnowledgeSourceType" AS ENUM ('FAQ','MANUAL','PRODUCT','POLICY','WARRANTY','PROCEDURE','GENERAL','OTHER')`);
  for (const section of ["pre-data", "data"]) docker(["pg_restore", "-U", "bot_qa", "-d", database, "--exit-on-error", "--no-owner", "--no-acl", "--schema=public", "--table=KnowledgeSource", `--section=${section}`, dump]);
}
console.log(sql(database, `SELECT COALESCE(json_agg(json_build_object('id',"id",'title',"title",'category',"category",'product',"product",'type',"type",'active',"active",'validUntil',"validUntil",'length',length("content"),'preview',left("content",220)) ORDER BY "title"),'[]') FROM "KnowledgeSource"`));
