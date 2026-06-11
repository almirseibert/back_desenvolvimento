// services/notificationEvents.js
// Catálogo dos eventos de notificação disparados pelo sistema.
// Esta é a fonte de verdade do que "tem um botão" no admin de Templates.
//
// Cada entrada define:
//   - key:        chave estável usada pelo dispatcher e como event_key na tabela
//                 message_templates. NUNCA mude uma key existente; isso quebra o
//                 vínculo com qualquer customização salva no banco.
//   - label:      nome amigável mostrado na UI.
//   - area:       agrupador na UI (espelha as áreas de Comunicação).
//   - variables:  lista de placeholders disponíveis no corpo (sem chaves).
//   - defaultBody: texto padrão usado quando não há customização no banco e
//                 também exibido na UI como "estado original" do template.
//
// Adicionar novo evento? Adicione aqui. Se quiser que o dispatcher faça
// formatação especial (datas, valores etc), use também o catálogo
// TEMPLATES do notificationDispatcher como fallback rico.

const EVENT_CATALOG = [
    {
        key: 'obra_criada',
        label: 'Nova obra cadastrada',
        area: 'obras',
        variables: ['nome', 'orgao_contratante', 'regiao'],
        defaultBody:
            'Foi cadastrada uma nova obra no sistema:\n\n' +
            '• Nome: {{nome}}\n' +
            '• Órgão contratante: {{orgao_contratante}}\n' +
            '• Região: {{regiao}}',
    },
    {
        key: 'obra_progresso',
        label: 'Obra atingiu marco de progresso',
        area: 'obras',
        variables: ['obra', 'pct'],
        defaultBody: '📊 A obra *{{obra}}* atingiu *{{pct}}%* de progresso.',
    },
    {
        key: 'combustivel_obra_20pct',
        label: 'Combustível da obra próximo do limite',
        area: 'abastecimento',
        variables: ['obra', 'pct', 'gastoAtual', 'orcamento'],
        defaultBody: '⚠️ A obra *{{obra}}* atingiu *{{pct}}%* do orçamento de combustível.',
    },
    {
        key: 'ordem_gerada',
        label: 'Ordem de abastecimento gerada',
        area: 'abastecimento',
        variables: ['numero', 'veiculo', 'posto', 'litros', 'combustivel'],
        defaultBody:
            '📄 Ordem de abastecimento gerada.\n\n' +
            '• Número: {{numero}}\n' +
            '• Veículo: {{veiculo}}\n' +
            '• Posto: {{posto}}\n' +
            '• Litros: {{litros}}\n' +
            '• Combustível: {{combustivel}}',
    },
    {
        key: 'revisao_veiculo_leve',
        label: 'Revisão próxima (veículo leve)',
        area: 'manutencoes',
        variables: ['placa', 'modelo', 'kmAtual', 'kmRevisao'],
        defaultBody:
            '🔧 Veículo *{{placa}}* ({{modelo}}) próximo da revisão.\n' +
            'Km atual: {{kmAtual}} / Km revisão: {{kmRevisao}}',
    },
    {
        key: 'revisao_veiculo_pesado',
        label: 'Revisão próxima (equipamento pesado)',
        area: 'manutencoes',
        variables: ['placa', 'modelo', 'hrAtual', 'hrRevisao'],
        defaultBody:
            '🔧 Equipamento *{{placa}}* ({{modelo}}) próximo da revisão.\n' +
            'Hr atual: {{hrAtual}} / Hr revisão: {{hrRevisao}}',
    },
    {
        key: 'documento_veiculo_vencido',
        label: 'Documento de veículo vencido',
        area: 'frota',
        variables: ['placa', 'tipoDocumento', 'vencimento'],
        defaultBody: '🚨 Documento *{{tipoDocumento}}* do veículo *{{placa}}* venceu em {{vencimento}}.',
    },
    {
        key: 'multa_lancada',
        label: 'Multa registrada',
        area: 'multas',
        variables: ['funcionario', 'motivo', 'valor', 'placa'],
        defaultBody:
            '🚨 Multa registrada para *{{funcionario}}*.\n\n' +
            '• Motivo: {{motivo}}\n' +
            '• Valor: R$ {{valor}}\n' +
            '• Veículo: {{placa}}',
    },
    {
        key: 'cnh_vencendo',
        label: 'CNH vencendo',
        area: 'funcionarios',
        variables: ['funcionario', 'vencimento', 'dias'],
        defaultBody: 'A CNH de *{{funcionario}}* vence em {{vencimento}} ({{dias}} dia(s) restante(s)).',
    },
    {
        key: 'cnh_vencida',
        label: 'CNH vencida',
        area: 'funcionarios',
        variables: ['funcionario', 'vencimento'],
        defaultBody: '🚨 A CNH de *{{funcionario}}* venceu em {{vencimento}}. Atenção imediata necessária.',
    },
    {
        key: 'toxicologico_vencendo',
        label: 'Exame toxicológico vencendo',
        area: 'funcionarios',
        variables: ['funcionario', 'vencimento', 'dias'],
        defaultBody: 'O exame toxicológico de *{{funcionario}}* vence em {{vencimento}} ({{dias}} dia(s) restante(s)).',
    },
    {
        key: 'funcionario_retornou_ferias',
        label: 'Funcionário retornou de férias',
        area: 'funcionarios',
        variables: ['nome'],
        defaultBody: 'O funcionário *{{nome}}* retornou de férias e está com status Ativo.',
    },
    {
        key: 'operador_placeholder_obra_7dias',
        label: 'Veículos sem operador real em obra (>7 dias)',
        area: 'frota',
        variables: [],
        defaultBody:
            '🚧 *Veículos sem operador real em obra (>7 dias)*\n\n' +
            'Os veículos abaixo estão alocados em obra com um operador fictício/placeholder ' +
            '(COLABORADOR, TESTE, MAK SERVIÇOS etc.) há mais de 7 dias. Enquanto não for ' +
            'atualizado o operador real, novas ordens de abastecimento ficam *bloqueadas*.',
    },
    {
        key: 'cobranca_horas_operacional',
        label: 'Cobrança de horas — Operacional',
        area: 'obras',
        variables: ['primeiro_nome', 'responsavel', 'veiculo', 'obra', 'dias'],
        defaultBody:
            'Olá, {{primeiro_nome}}! Tudo bem? 😊\n\n' +
            'Notamos que o lançamento de horas do equipamento *{{veiculo}}* na obra *{{obra}}* está pendente há *{{dias}} dia(s)*.\n\n' +
            'Por gentileza, poderia regularizar o registro das horas assim que possível? Isso nos ajuda a manter o controle da obra em dia.\n\n' +
            'Agradecemos a colaboração! 🙏\n— Equipe MAK Serviços',
    },
];

const EVENT_BY_KEY = EVENT_CATALOG.reduce((acc, e) => { acc[e.key] = e; return acc; }, {});

const getEvent = (key) => EVENT_BY_KEY[key] || null;
const isKnownEvent = (key) => Boolean(EVENT_BY_KEY[key]);

// Substitui {{var}} no texto usando o payload. Variáveis ausentes ficam como "—".
const renderBody = (body, payload = {}) =>
    String(body || '').replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k) => {
        const v = payload[k];
        return v === undefined || v === null || v === '' ? '—' : String(v);
    });

module.exports = { EVENT_CATALOG, getEvent, isKnownEvent, renderBody };
