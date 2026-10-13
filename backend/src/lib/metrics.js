// AMAZON CLOUDWATCH - métricas de negócio (ingressos vendidos, reservas...) para o dashboard.
// Envio em segundo plano: uma falha de métrica nunca atrapalha a venda.
// Ativado com METRICS_NAMESPACE (o Terraform define "StadiumTickets" nas instâncias).
const { CloudWatchClient, PutMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { AWS_REGION } = require('../config');

const NAMESPACE = process.env.METRICS_NAMESPACE;
const cloudwatch = NAMESPACE ? new CloudWatchClient({ region: AWS_REGION }) : null;

function putMetric(name, value = 1, unit = 'Count') {
  if (!cloudwatch) return;
  cloudwatch.send(new PutMetricDataCommand({
    Namespace: NAMESPACE,
    MetricData: [{ MetricName: name, Value: value, Unit: unit, Timestamp: new Date() }]
  })).catch((err) => console.warn(`[CloudWatch] Falha ao publicar métrica ${name}:`, err.message));
}

module.exports = { putMetric };
