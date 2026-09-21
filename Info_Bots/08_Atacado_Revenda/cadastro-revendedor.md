---
type: wholesale
topic: reseller_registration
brand: Mibro
updated: 2026-09-18
---

# Atacado e Revenda — Cadastro de Revendedor

## Objetivo

Este arquivo orienta o Bot sobre o cadastro inicial de:

- lojistas
- revendedores
- empresas interessadas em comprar no atacado
- clientes com CNPJ
- parceiros comerciais

O Bot deve coletar apenas os dados necessários para:

- identificar a empresa
- entender o interesse
- preparar a cotação
- encaminhar corretamente para o comercial

O cadastro não significa aprovação automática como revendedor.

---

# Regra principal

O Bot NÃO deve afirmar:

- "seu cadastro foi aprovado"
- "você já é revendedor autorizado"
- "sua empresa foi aceita"
- "você terá desconto de X%"
- "essa será sua tabela"

sem confirmação real da equipe responsável.

Cadastro e aprovação são etapas diferentes.

---

# Fluxo recomendado

O fluxo pode seguir:

1. identificar interesse em revenda;
2. confirmar existência de CNPJ;
3. coletar CNPJ;
4. consultar dados empresariais, quando houver integração;
5. pedir confirmação dos dados;
6. entender produtos/quantidade;
7. registrar vendedor responsável;
8. criar ou preparar cotação;
9. encaminhar para análise comercial.

---

# Quem entra neste fluxo

Exemplos:

- "Quero ser revendedor."
- "Tenho uma loja."
- "Quero vender Mibro."
- "Tenho CNPJ."
- "Vocês trabalham com lojista?"
- "Quero preço para revenda."

---

# Cliente sem CNPJ

Se o cliente não possui CNPJ:

não inventar aprovação excepcional.

Pode responder:

"O fluxo de revenda/atacado é voltado a empresas. Se você ainda não possui CNPJ, posso registrar seu interesse ou te orientar pelas condições de varejo."

Se a operação futuramente aceitar outro formato:

seguir a regra atual do sistema.

---

# CNPJ

O CNPJ é o principal identificador empresarial do cadastro.

Quando solicitado:

usar o fluxo seguro da Central.

Evitar repetir o CNPJ em mensagens desnecessariamente.

---

# Consulta automática de CNPJ

Quando houver integração:

o sistema pode buscar informações como:

- razão social
- nome fantasia
- situação cadastral
- endereço
- município
- UF
- CEP
- e-mail, quando disponível

O Bot deve apresentar os dados para confirmação.

---

# Dados divergentes

Se o cliente disser:

"Esse endereço não está correto."

não insistir no dado retornado.

Permitir correção conforme o fluxo autorizado.

Registrar:

- dado consultado
- dado informado pelo cliente

quando necessário.

---

# Razão social

Utilizar a razão social retornada/confirmada.

Não inventar abreviações.

---

# Nome fantasia

Pode ser usado para facilitar o atendimento comercial.

Não substituir razão social em processos fiscais quando ela for necessária.

---

# Situação cadastral

Se o sistema retornar situação cadastral:

não fazer interpretação jurídica ou fiscal complexa.

Se houver situação incompatível com o fluxo:

encaminhar para comercial/faturamento.

---

# Endereço

O endereço empresarial pode ser utilizado para:

- cadastro
- cotação
- cálculo logístico
- estimativa fiscal

Confirmar antes de usar quando houver divergência.

---

# UF

A UF é importante porque pode afetar:

- impostos
- frete
- logística
- condição da operação

Não estimar manualmente se a integração puder consultar.

---

# E-mail

O e-mail pode ser utilizado para:

- contato comercial
- proposta
- aprovação
- documentos
- link de pagamento

Confirmar que o endereço está correto.

---

# Telefone

Pode ser utilizado pelo vendedor para contato.

Não exigir se já estiver disponível no atendimento atual e for suficiente.

---

# Comprador responsável

Quando aplicável, registrar:

- nome
- cargo/função, se informado
- contato

Não pedir cargo se não houver necessidade.

---

# Vendedor responsável

O cadastro pode ficar vinculado ao vendedor comercial responsável.

Isso ajuda em:

- acompanhamento
- cotação
- histórico
- follow-up

Não alterar o responsável sem regra/autorização.

---

# Supervisor

Quando a operação exigir:

o supervisor pode acompanhar ou aprovar determinados processos.

O cliente não precisa receber detalhes internos de hierarquia.

---

# Tipo de negócio

Pode ser útil saber se a empresa é:

- loja física
- e-commerce
- distribuidor
- integrador
- outro tipo de revenda

Perguntar apenas se isso ajudar no atendimento.

---

# Interesse do cliente

Depois do CNPJ:

entender o interesse comercial.

Perguntas úteis:

- quais modelos procura?
- quantidade aproximada?
- já trabalha com eletrônicos/smartwatches?

Não perguntar tudo de uma vez.

---

# Quantidade

A operação de atacado atual começa a partir de:

10 unidades

Se o cliente ainda não sabe a quantidade:

pode informar uma estimativa.

---

# Mix de produtos

As 10 unidades não precisam ser tratadas automaticamente como 10 do mesmo modelo.

O cliente pode ter interesse em:

- mix de produtos
- vários modelos
- diferentes quantidades

A regra final deve vir do fluxo comercial vigente.

---

# Cadastro antes da cotação

É possível cadastrar o cliente antes de haver cotação definitiva.

Isso é útil para:

- histórico
- follow-up
- atribuição de vendedor
- futuras oportunidades

Cadastro não obriga o cliente a comprar.

---

# Cotação teste x cotação real

Se o sistema possuir essa distinção:

não confundir cotação de teste com proposta real enviada ao cliente.

Somente cotação válida/aprovada deve seguir para pedido.

---

# Histórico

O sistema pode registrar:

- contatos
- cotações
- pedidos
- interações
- vendedor responsável
- follow-ups

O Bot deve usar esse histórico para evitar perguntas repetidas.

---

# Cliente já cadastrado

Se o CNPJ já existir:

não criar cadastro duplicado automaticamente.

Consultar o cadastro existente.

---

# CNPJ duplicado

Se houver mais de um cadastro para o mesmo CNPJ:

encaminhar para revisão interna.

Não criar um terceiro registro.

---

# Contato diferente para mesma empresa

Uma empresa pode possuir vários contatos.

Não assumir que é outra empresa apenas porque mudou o nome do comprador.

---

# Filiais

Filiais podem possuir CNPJs diferentes.

Tratar conforme cadastro fiscal correspondente.

---

# Matriz e filial

Não misturar dados automaticamente.

Cada CNPJ deve ser tratado conforme retorno do sistema.

---

# Documentação

Não exigir documentos adicionais sem regra real.

Se a equipe precisar de:

- cartão CNPJ
- contrato social
- comprovante
- inscrição estadual

isso deve ser solicitado pelo fluxo comercial/fiscal apropriado.

---

# Inscrição Estadual

Pode ser relevante em algumas operações.

Não inventar obrigatoriedade.

Se o sistema/faturamento exigir:

seguir a regra retornada.

---

# Aprovação como revendedor

Cadastro comercial não significa autorização formal para uso de marca ou status de "revendedor autorizado".

Esses conceitos devem ser separados.

---

# Revendedor autorizado

O Bot só deve afirmar que uma empresa é revendedora autorizada quando houver registro oficial confirmando isso.

Não inferir apenas porque já fez compra no atacado.

---

# Uso da marca Mibro

Não conceder automaticamente permissão para:

- usar logotipo
- criar material oficial
- se apresentar como representante
- alterar identidade visual

Solicitações desse tipo devem ser encaminhadas.

---

# Exclusividade

Se o cliente perguntar:

"Posso ser exclusivo na minha região?"

encaminhar para comercial.

Não prometer.

---

# Região

Pode ser útil registrar a região de atuação.

Isso não significa exclusividade.

---

# Marketplace

Se o revendedor pretende vender em:

- Mercado Livre
- Amazon
- Shopee
- outros marketplaces

registrar quando relevante.

Não afirmar automaticamente que qualquer canal está autorizado.

---

# Política de preço

Não impor preço de revenda ao cliente sem política oficial.

O Bot não deve inventar:

- preço mínimo
- margem
- markup obrigatório

---

# Margem

Se o cliente perguntar:

"Qual minha margem?"

isso depende de:

- preço de compra
- preço de venda
- impostos
- frete
- promoções

Não prometer percentual fixo.

---

# Tabela comercial

Não enviar tabela antiga.

Usar cotação atual.

---

# Estoque

Antes de cotar grandes quantidades:

consultar disponibilidade.

Estoque do varejo não representa necessariamente estoque disponível para atacado.

---

# Lançamentos

Produtos `coming_soon` não devem ser cadastrados como disponibilidade garantida.

Pode registrar interesse futuro.

---

# Lead de revenda

Se o cliente ainda não quer comprar agora:

pode ser cadastrado como lead, se o sistema permitir.

Exemplo:

Interesse: revenda futura
Volume estimado: não definido
Follow-up: necessário

---

# Follow-up

O comercial pode configurar retorno futuro.

O Bot não deve prometer data de contato se ela não estiver definida.

---

# Cliente quer apenas informações

Não obrigar cadastro completo imediatamente.

Pode primeiro responder:

- mínimo
- funcionamento geral
- etapas

Depois pedir CNPJ quando ele quiser avançar.

---

# Cliente quer avançar

Exemplo:

"Quero fazer uma cotação."

Aí faz sentido coletar:

- CNPJ
- produtos
- quantidades

---

# Exemplo — primeiro contato

Cliente:

"Quero ser revendedor."

Bot:

"Claro. O fluxo de atacado começa a partir de 10 unidades. Você já possui CNPJ?"

---

# Exemplo — possui CNPJ

Cliente:

"Sim."

Bot:

"Perfeito. Pode me informar o CNPJ da empresa? Vou usar apenas para localizar os dados comerciais e preparar o cadastro."

---

# Exemplo — dados encontrados

Bot:

"Localizei os dados da empresa. A razão social e o endereço estão corretos?"

Se não:

permitir correção.

---

# Exemplo — cadastro pronto

Cliente:

"Já passei o CNPJ. E agora?"

Bot:

"O próximo passo é entender os produtos e quantidades que você pretende cotar. Depois disso, o pedido pode seguir para análise comercial e aprovação."

---

# Exemplo — cliente sem quantidade definida

Cliente:

"Não sei quantas unidades ainda."

Bot:

"Sem problema. Podemos registrar seu interesse primeiro. Quando você tiver uma estimativa de quantidade e os modelos, montamos a cotação."

---

# Exemplo — marketplace

Cliente:

"Quero revender no Mercado Livre."

Bot:

"Posso registrar esse canal de venda no seu cadastro. As condições e autorizações comerciais específicas precisam ser confirmadas pela equipe antes de qualquer compromisso."

---

# Quando encaminhar para humano

Encaminhar quando houver:

- pedido de exclusividade
- negociação especial
- grande volume
- problema no CNPJ
- situação cadastral incomum
- necessidade fiscal
- autorização de uso de marca
- marketplaces/condições especiais
- parceria estratégica
- dúvidas não documentadas

---

# Informações úteis antes do handoff

Coletar ou obter:

- CNPJ
- razão social
- nome fantasia
- contato
- e-mail
- telefone
- cidade/UF
- tipo de negócio
- produtos de interesse
- quantidade aproximada
- canal de venda
- vendedor responsável

---

# Resumo para humano

Exemplo:

Setor: Atacado / Revenda
Empresa: Loja XYZ LTDA
CNPJ: cadastrado
Cidade/UF: Campinas/SP
Contato: comprador responsável
Canal: loja física + e-commerce
Interesse: Mibro Lite 3 Pro e GS Pro 2
Quantidade estimada: 20 unidades
Cadastro: concluído
Cotação: ainda não criada
Pendência: montar proposta comercial

---

# O que o Bot pode fazer

Pode:

- identificar interesse em revenda
- solicitar CNPJ
- consultar empresa
- confirmar dados
- registrar contato
- registrar interesse
- coletar quantidade
- preparar cotação
- encaminhar

---

# O que o Bot NÃO deve fazer

Não deve:

- aprovar revendedor sozinho
- afirmar autorização oficial sem registro
- prometer exclusividade
- inventar margem
- inventar desconto
- duplicar empresa sem verificar
- exigir documentos sem necessidade
- autorizar uso de marca
- prometer estoque
- prometer condição comercial

---

# Regra final

Cadastro identifica a empresa.

Cotação define a oportunidade.

Aprovação comercial define a condição.

Ser cadastrado não significa automaticamente ser revendedor autorizado.