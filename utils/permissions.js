const ROLE_PAGE_ACCESS = {
  admin:         ['*'],
  gerencia:      ['dashboard','obras','expenses','operacional','billing','reports','refueling','comboio','admin_solicitacoes','orders','revisions','tires','vehicles','employees','partners','inventory','fines','sigasul','supervisor_dashboard'],
  rh:            ['dashboard','obras','billing','reports','vehicles','employees','fines'],
  faturamento:   ['dashboard','obras','operacional','billing','reports','vehicles'],
  abastecimento: ['dashboard','obras','expenses','reports','refueling','comboio','admin_solicitacoes','orders','vehicles','partners','inventory'],
  oficina:       ['dashboard','obras','reports','revisions','tires','orders','vehicles','inventory'],
  editor:        ['dashboard','obras','expenses','operacional','billing','reports','refueling','comboio','admin_solicitacoes','orders','revisions','tires','vehicles','employees','partners','inventory','fines'],
  supervisor:    ['dashboard','obras','supervisor_dashboard','expenses','operacional','billing','reports','revisions','tires','orders','vehicles'],
  operador:      ['admin_solicitacoes_app'],
  viewer:        ['dashboard','reports'],
  visualizador:  ['dashboard','reports'],
};

const VEHICLE_ACTION_BUTTONS = {
  admin:         ['edit','checklist','fines','history','documents','delete','block'],
  gerencia:      ['edit','checklist','fines','history','documents','block'],
  rh:            ['checklist','fines','history'],
  faturamento:   ['checklist','history'],
  abastecimento: ['checklist','history'],
  oficina:       ['checklist','history'],
  editor:        ['edit','checklist','fines','history','documents'],
  supervisor:    ['checklist','history'],
  viewer:        [],
  visualizador:  [],
};

// Roles que NÃO podem excluir nada
const ROLES_NO_DELETE = ['gerencia','rh','faturamento','abastecimento','oficina','viewer','visualizador'];

// Roles que NÃO podem liberar com senha admin
const ROLES_NO_PASSWORD_RELEASE = ['gerencia','rh','faturamento','abastecimento','oficina','viewer','visualizador','editor'];

function canAccessPage(role, pageId) {
  const pages = ROLE_PAGE_ACCESS[role?.toLowerCase()] || ROLE_PAGE_ACCESS['viewer'];
  return pages.includes('*') || pages.includes(pageId);
}

function getVehicleButtons(role) {
  return VEHICLE_ACTION_BUTTONS[role?.toLowerCase()] || [];
}

module.exports = { ROLE_PAGE_ACCESS, VEHICLE_ACTION_BUTTONS, ROLES_NO_DELETE, ROLES_NO_PASSWORD_RELEASE, canAccessPage, getVehicleButtons };
