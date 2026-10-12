// AMAZON SNS / SQS - Desacoplamento assíncrono (Req. 6).
// Fluxo na AWS: API -> SNS (tópico) -> SQS (assinatura) -> Worker.
// Sem SNS configurado publicamos direto no SQS; sem nenhum dos dois, usa a fila local (dev).
const { SQSClient, SendMessageCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');
const { AWS_REGION } = require('../config');
const localStore = require('./localStore');

const QUEUE_URL = process.env.SQS_QUEUE_URL;
const TOPIC_ARN = process.env.SNS_TOPIC_ARN;
const sqs = QUEUE_URL ? new SQSClient({ region: AWS_REGION }) : null;
const sns = TOPIC_ARN ? new SNSClient({ region: AWS_REGION }) : null;

const hasSqs = () => !!sqs;

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

// ---------- Consumidor (usado pelo worker) ----------
async function deleteMessage(receiptHandle) {
  await sqs.send(new DeleteMessageCommand({ QueueUrl: QUEUE_URL, ReceiptHandle: receiptHandle }));
}

// Long polling (5 s). Retorna [{ receiptHandle, receiveCount, data }].
async function receiveTasks() {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl: QUEUE_URL,
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
      await deleteMessage(msg.ReceiptHandle)
        .catch((e) => console.warn('[Worker SQS] Erro ao descartar mensagem inválida:', e.message));
    }
  }
  return tasks;
}

module.exports = {
  hasSqs,
  publishTask,
  receiveTasks,
  deleteMessage,
  pullLocalTask: localStore.pullLocalTask
};
