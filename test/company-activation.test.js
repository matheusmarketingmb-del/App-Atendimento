require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const prisma = require('../src/database/prisma');
const companies = require('../src/services/company-service');
const authorization = require('../src/services/authorization-service');
const inbox = require('../src/services/inbox-service');
const users = require('../src/services/user-management-service');

test('desativar empresa oculta recursos e preserva vínculos ao editar equipe; reativar restaura', async () => {
  const suffix = `${Date.now()}`;
  const master = await prisma.user.create({ data:{ name:'Master toggle', email:`master-${suffix}@toggle.test`, role:'ADMIN' } });
  let company, agent;
  try {
    company = await companies.createCompany({ name:'Empresa toggle', slug:`toggle-${suffix}`, primaryColor:'#123456' }, master);
    const category = await prisma.category.create({ data:{ companyId:company.id, code:`TOGGLE_${suffix}`, name:'Setor toggle' } });
    const mibroCategory = await prisma.category.findFirstOrThrow({ where:{ companyId:'cmp_mibro', active:true, parentId:null } });
    agent = await prisma.user.create({ data:{ name:'Agent toggle', email:`agent-${suffix}@toggle.test`, role:'ATENDENTE',
      companyAccess:{ create:[{ companyId:company.id, role:'SUPERVISOR' },{ companyId:'cmp_mibro' }] },
      categoryAccess:{ create:[{ categoryId:category.id },{ categoryId:mibroCategory.id }] },
    } });
    assert.ok((await companies.companyAccess({id:master.id,role:'ADMIN'})).some(row => row.companyId === company.id));
    await assert.rejects(() => companies.updateCompany(company.id,{active:false},agent), {statusCode:403});
    await assert.rejects(() => companies.updateCompany(company.id,{active:'false'},master), {statusCode:400});
    await companies.updateCompany(company.id,{active:false},master);
    assert.ok(!(await companies.companyAccess({id:master.id,role:'ADMIN'})).some(row => row.companyId === company.id));
    assert.ok(!(await inbox.listCategories({id:master.id,role:'ADMIN'})).some(row => row.id === category.id));
    const scope = await authorization.conversationScope({id:master.id,role:'ADMIN'});
    assert.ok(!scope.companyId.in.includes(company.id));
    await users.updateUser(agent.id,{ companyAccess:[{companyId:'cmp_mibro',active:true}], categoryIds:[mibroCategory.id] },master.id);
    const hiddenAccess = await prisma.userCompanyAccess.findUnique({where:{userId_companyId:{userId:agent.id,companyId:company.id}}});
    assert.equal(hiddenAccess.role,'SUPERVISOR');
    assert.ok(await prisma.userCategoryAccess.findUnique({where:{userId_categoryId:{userId:agent.id,categoryId:category.id}}}));
    await companies.updateCompany(company.id,{active:true},master);
    assert.ok((await inbox.listCategories({id:master.id,role:'ADMIN'})).some(row => row.id === category.id));
    assert.equal(await companies.roleInCompany({id:agent.id,role:'ATENDENTE'},company.id),'SUPERVISOR');
  } finally {
    if (agent) await prisma.user.delete({where:{id:agent.id}});
    if (company) { await prisma.category.deleteMany({where:{companyId:company.id}}); await prisma.company.delete({where:{id:company.id}}); }
    await prisma.user.delete({where:{id:master.id}});
    companies.invalidateCompanyCache();
    await prisma.$disconnect();
  }
});
