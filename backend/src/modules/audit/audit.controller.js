const AuditLog = require('./audit.model');

// GET /audit-logs - registros mais recentes primeiro
async function list(req, res) {
  try {
    return res.json(await AuditLog.listAuditLogs(100));
  } catch (error) {
    console.warn('[DynamoDB] Erro ao consultar logs:', error.message);
    return res.json(AuditLog.localAuditLogs);
  }
}

module.exports = { list };
