// AMAZON SNS / SQS - Desacoplamento assíncrono (Req. 6).
// Fluxo na AWS: API -> SNS (tópico) -> SQS (assinatura) -> Worker.
// Sem SNS configurado publicamos direto no SQS; sem nenhum dos dois, usa a fila local (dev).
const { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { AWS_REGION } = require('../config');
const localStore = require('./localStore');

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const ORDER_TOPIC_ARN = process.env.SNS_ORDER_EVENTS_TOPIC_ARN;

// Filas consumidas pelo worker (cada uma com o seu tipo de tarefa)
const QUEUES = {
  banner: process.env.SQS_QUEUE_URL,
  ticket: process.env.SQS_TICKETS_QUEUE_URL,
  notification: process.env.SQS_NOTIFICATIONS_QUEUE_URL
};
const anyQueue = Object.values(QUEUES).some(Boolean);

const sqs = anyQueue ? new SQSClient({ region: AWS_REGION }) : null;
const sns = TOPIC_ARN ? new SNSClient({ region: AWS_REGION }) : null;
const orderSns = ORDER_TOPIC_ARN ? new SNSClient({ region: AWS_REGION }) : null;

const hasSqs = () => !!sqs;
// [{ kind, url }] das filas configuradas
const configuredQueues = () => Object.entries(QUEUES).filter(([, url]) => url).map(([kind, url]) => ({ kind, url }));

// ---------- Produtor (usado pela API) ----------
async function publishTask(taskPayload) {
  const message = {
    type: 'RESCALE_BANNER',
    ...taskPayload,
    enqueuedAt: new Date().toISOString()
  };

  if (sns) {
    await sns.send(new PublishCommand({
      TopicArn: TOPIC_ARN,
      Subject: 'Process Banner Task',
      Message: JSON.stringify(message)
    }));
    return { provider: 'Amazon SNS -> SQS', enqueued: true };
  }

  if (sqs) {
    await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify(message) }));
    return { provider: 'Amazon SQS', enqueued: true };
  }

  try {
    localStore.pushLocalTask(message);
    return { provider: 'Local Queue', enqueued: true };
  } catch (error) {
    console.warn('[Queue] Erro ao enfileirar tarefa local:', error.message);
    return { provider: 'Local Queue (erro)', enqueued: false };
  }
}

// Evento PEDIDO_CONFIRMADO. Na AWS vai para o tópico SNS de pedidos, que entrega a DUAS filas SQS
// independentes (fan-out): uma gera o PDF do ingresso e a outra envia o e-mail ao cliente.
// Sem SNS (desenvolvimento) o fan-out é simulado com duas tarefas na fila local.
async function publishOrderConfirmed(payload) {
  const message = { type: 'ORDER_CONFIRMED', ...payload, publishedAt: new Date().toISOString() };

  if (orderSns) {
    await orderSns.send(new PublishCommand({
      TopicArn: ORDER_TOPIC_ARN,
      Subject: 'Pedido confirmado',
      Message: JSON.stringify(message)
    }));
    return { provider: 'Amazon SNS (fan-out -> SQS ingresso + SQS e-mail)' };
  }

  localStore.pushLocalTask({ ...message, target: 'ticket' });
  localStore.pushLocalTask({ ...message, target: 'notification' });
  return { provider: 'Local Queue (fan-out simulado)' };
}

// ---------- Consumidor (usado pelo worker) ----------
async function deleteMessage(queueUrl, receiptHandle) {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: receiptHandle }));
}

// Long polling (5 s) numa fila. Retorna [{ receiptHandle, receiveCount, data }].
async function receiveTasks(queueUrl) {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: queueUrl,
    MaxNumberOfMessages: 5,
    WaitTimeSeconds: 5,
    VisibilityTimeout: 120,
    AttributeNames: ['ApproximateReceiveCount']
  }));

  const tasks = [];
  for (const msg of result.Messages || []) {
    try {
      let body = JSON.parse(msg.Body);
      // Suporte se a mensagem veio encapsulada via SNS (sem raw message delivery)
      if (body.TopicArn && body.Message) {
        body = JSON.parse(body.Message);
      }
      tasks.push({
        receiptHandle: msg.ReceiptHandle,
        receiveCount: Number(msg.Attributes?.ApproximateReceiveCount || 1),
        data: body
      });
    } catch (err) {
      // Mensagem ilegível nunca terá sucesso: não é reprocessada.
      console.warn('[Worker SQS] Mensagem com formato inválido descartada:', err.message);
      await deleteMessage(queueUrl, msg.ReceiptHandle)
        .catch((e) => console.warn('[Worker SQS] Erro ao descartar mensagem inválida:', e.message));
    }
  }
  return tasks;
}

module.exports = {
  hasSqs,
  configuredQueues,
  publishTask,
  publishOrderConfirmed,
  receiveTasks,
  deleteMessage,
  pullLocalTask: localStore.pullLocalTask
};
