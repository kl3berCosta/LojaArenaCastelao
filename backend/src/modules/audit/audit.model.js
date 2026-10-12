// AMAZON DYNAMODB - Auditoria NoSQL de ações do CRUD (tipo da ação, dados manipulados e hora).
// Todo item recebe pk='AUDIT' para entrar no índice global "by-time" (pk + timestamp),
// permitindo listar os registros MAIS RECENTES em ordem (Scan não garante ordem).
const crypto = require('node:crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { AWS_REGION } = require('../../config');

const AUDIT_PK = 'AUDIT';
const AUDIT_INDEX = 'by-time';
const TABLE = process.env.DYNAMODB_TABLE_NAME;

const dynamodb = TABLE
  ? DynamoDBDocumentClient.from(new DynamoDBClient({ region: AWS_REGION }), { marshallOptions: { removeUndefinedValues: true } })
  : null;

const localAuditLogs = []; // cópia em memória (usada sozinha em desenvolvimento)

// Registra uma ação. Nunca lança erro: falha de auditoria não derruba a operação principal.
async function logCrudAction(action, resource, payload) {
  const logEntry = {
    id: crypto.randomUUID(),
    pk: AUDIT_PK,
    action,
    resource,
    payload: JSON.stringify(payload),
    timestamp: new Date().toISOString()
  };

  localAuditLogs.unshift(logEntry);
  if (localAuditLogs.length > 100) localAuditLogs.pop();

  if (dynamodb) {
    try {
      await dynamodb.send(new PutCommand({ TableName: TABLE, Item: logEntry }));
    } catch (error) {
      console.warn('[DynamoDB] Erro ao salvar log de auditoria:', error.message);
    }
  }

  return logEntry;
}

async function listAuditLogs(limit = 100) {
  if (!dynamodb) return localAuditLogs;

  try {
    const result = await dynamodb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: AUDIT_INDEX,
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': AUDIT_PK },
      ScanIndexForward: false,
      Limit: limit
    }));
    return result.Items || [];
  } catch (err) {
    console.warn('[DynamoDB] Query no índice falhou, usando Scan ordenado:', err.message);
  }

  const items = [];
  let startKey;
  do {
    const page = await dynamodb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey: startKey }));
    items.push(...(page.Items || []));
    startKey = page.LastEvaluatedKey;
  } while (startKey && items.length < 1000);
  items.sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return items.slice(0, limit);
}

module.exports = { logCrudAction, listAuditLogs, localAuditLogs };
