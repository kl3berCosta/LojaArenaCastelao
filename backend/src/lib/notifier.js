// E-MAIL AOS CLIENTES via AMAZON SNS (protocolo "email").
// O Amazon SES é bloqueado no AWS Academy, então usamos um tópico SNS de notificações:
//  - no cadastro, o e-mail do cliente é assinado no tópico com um FILTRO (FilterPolicy) pelo próprio
//    endereço; a AWS envia um e-mail de confirmação que o cliente precisa aceitar;
//  - cada mensagem é publicada com o atributo "email" do destinatário, e o filtro garante que
//    só ele a recebe.
// Em desenvolvimento (sem tópico) os e-mails são gravados em backend/data/outbox/.
const fs = require('node:fs');
const path = require('node:path');
const { SNSClient, SubscribeCommand, PublishCommand, ListSubscriptionsByTopicCommand } = require('@aws-sdk/client-sns');
const { AWS_REGION, DATA_DIR } = require('../config');

const TOPIC_ARN = process.env.SNS_CUSTOMER_EMAIL_TOPIC_ARN;
const sns = TOPIC_ARN ? new SNSClient({ region: AWS_REGION }) : null;
const OUTBOX = () => path.join(DATA_DIR, 'outbox');

const isEnabled = () => !!sns;

// O SNS exige assunto em ASCII, sem quebras de linha e com menos de 100 caracteres.
const asciiSubject = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7E]/g, '').slice(0, 99);

async function subscribe(email) {
  if (!sns) return { status: 'local' };
  await sns.send(new SubscribeCommand({
    TopicArn: TOPIC_ARN,
    Protocol: 'email',
    Endpoint: email,
    Attributes: { FilterPolicy: JSON.stringify({ email: [email] }) },
    ReturnSubscriptionArn: true
  }));
  return { status: 'pending' };
}

// confirmed | pending | none (ou local em desenvolvimento)
async function subscriptionStatus(email) {
  if (!sns) return 'local';
  let token;
  let found = null;
  let pages = 0;
  do {
    const page = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: TOPIC_ARN, NextToken: token }));
    for (const sub of page.Subscriptions || []) {
      if (String(sub.Endpoint).toLowerCase() !== email) continue;
      if (String(sub.SubscriptionArn).startsWith('arn:')) return 'confirmed';
      found = 'pending';
    }
    token = page.NextToken;
    pages += 1;
  } while (token && pages < 20);
  return found || 'none';
}

async function sendEmail({ to, subject, text }) {
  if (!sns) {
    fs.mkdirSync(OUTBOX(), { recursive: true });
    const file = path.join(OUTBOX(), `${Date.now()}-${to.replace(/[^a-z0-9@._-]/gi, '_')}.txt`);
    fs.writeFileSync(file, `Para: ${to}\nAssunto: ${subject}\n\n${text}\n`, 'utf8');
    return { provider: 'local-outbox', file };
  }
  await sns.send(new PublishCommand({
    TopicArn: TOPIC_ARN,
    Subject: asciiSubject(subject),
    Message: text,
    MessageAttributes: { email: { DataType: 'String', StringValue: to } }
  }));
  return { provider: 'Amazon SNS (email)' };
}

module.exports = { isEnabled, subscribe, subscriptionStatus, sendEmail, asciiSubject };
