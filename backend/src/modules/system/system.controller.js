// CONTROLLER de sistema: healthcheck do ALB e carga de CPU para demonstrar o Auto Scaling.
const os = require('node:os');
const { Worker } = require('node:worker_threads');

// GET /health - usado pelo health check do ALB e pelo painel admin
function health(req, res) {
  res.json({
    status: 'ok',
    service: 'stadium-tickets-api',
    instance: {
      hostname: os.hostname(),
      platform: os.platform(),
      uptime: process.uptime()
    },
    awsServices: {
      ec2: process.env.EC2_INSTANCE_ID || 'executando-na-instancia-ec2',
      rds: !!(process.env.DATABASE_URL || process.env.DB_HOST),
      elasticache: !!(process.env.REDIS_HOST || process.env.REDIS_URL),
      s3: !!process.env.S3_BUCKET_NAME,
      dynamodb: !!process.env.DYNAMODB_TABLE_NAME,
      sqsSns: !!(process.env.SQS_QUEUE_URL || process.env.SNS_TOPIC_ARN),
      orderFanout: !!(process.env.SNS_ORDER_EVENTS_TOPIC_ARN && process.env.SQS_TICKETS_QUEUE_URL && process.env.SQS_NOTIFICATIONS_QUEUE_URL),
      emailSns: !!process.env.SNS_CUSTOMER_EMAIL_TOPIC_ARN,
      cloudwatchMetrics: !!process.env.METRICS_NAMESPACE
    }
  });
}

// Código executado em cada thread de carga: laço de CPU até o prazo.
const BURN_CODE = `
  const { workerData } = require('node:worker_threads');
  let x = 0;
  while (Date.now() < workerData.until) { x += Math.sqrt(Math.random() * 1000000); }
`;

// Threads de carga ativas. Limitamos ao dobro dos vCPUs para não sufocar a thread principal
// (que precisa responder ao /health do ALB) quando várias requisições /stress chegam juntas.
let activeBurners = 0;
const vcpus = Math.max(1, os.cpus().length);

// GET /stress (admin) - limite de 30s por requisição, abaixo do idle timeout de 60s do ALB.
// Uma thread por vCPU: a EC2 t3.micro tem 2 vCPUs e o CloudWatch mede a média de TODAS elas,
// então um laço em uma única thread só chegaria a ~50% e nunca passaria dos 70% do alarme.
// As threads rodam fora do event loop, então o /health continua respondendo.
function stress(req, res) {
  const requested = Number(req.query.duration);
  const durationMs = Math.min(Number.isFinite(requested) && requested > 0 ? requested : 10000, 30000);
  const until = Date.now() + durationMs;

  const toSpawn = Math.max(0, Math.min(vcpus, vcpus * 2 - activeBurners));
  let pending = toSpawn;

  const finish = () => {
    res.json({
      message: `Carga de CPU executada por ${durationMs}ms`,
      instance: os.hostname(),
      threads: toSpawn
    });
  };

  if (toSpawn === 0) {
    // Já há carga suficiente rodando: apenas espera o prazo (a carga existente mantém a CPU alta).
    return void setTimeout(finish, durationMs);
  }

  activeBurners += toSpawn;
  for (let i = 0; i < toSpawn; i++) {
    const worker = new Worker(BURN_CODE, { eval: true, workerData: { until } });
    let done = false;
    const onEnd = () => {
      if (done) return;
      done = true;
      activeBurners -= 1;
      pending -= 1;
      if (pending === 0) finish();
    };
    worker.once('exit', onEnd);
    worker.once('error', onEnd);
  }
}

module.exports = { health, stress };
