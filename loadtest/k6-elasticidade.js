// Teste de carga da Parte 2 (elasticidade) com k6.
//
// Dois cenários rodam juntos:
//  - carga_cpu:  usuários virtuais chamam GET /stress (rota do admin), que ocupa todas as vCPUs da
//                instância por alguns segundos. Isso leva a CPU média do grupo acima de 70% e faz o
//                Auto Scaling criar novas instâncias;
//  - navegacao:  torcedores navegando na vitrine (GET /events), para mostrar que o site continua
//                respondendo durante a carga.
//
// Uso (ver README.md desta pasta):
//   BASE_URL=http://<seu-alb> ADMIN_PASSWORD='senha' \
//   K6_WEB_DASHBOARD=true K6_WEB_DASHBOARD_EXPORT=relatorio-k6.html k6 run k6-elasticidade.js
import http from 'k6/http';
import { check, sleep } from 'k6';

const BASE_URL = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const ADMIN_PASSWORD = __ENV.ADMIN_PASSWORD || '';
const VUS = Number(__ENV.VUS || 12); // usuários virtuais gerando carga de CPU
const RAMP = __ENV.RAMP || '1m'; // subida da carga
const HOLD = __ENV.HOLD || '6m'; // carga sustentada (tempo para o Auto Scaling reagir)
const DOWN = __ENV.DOWN || '30s'; // descida
const STRESS_MS = Number(__ENV.STRESS_MS || 4000); // duração de cada requisição /stress

const toSeconds = (d) => {
  const m = String(d).match(/^(\d+)(ms|s|m|h)$/);
  if (!m) throw new Error(`Duração inválida: ${d}`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
};
const TOTAL = `${Math.ceil(toSeconds(RAMP) + toSeconds(HOLD) + toSeconds(DOWN))}s`;

export const options = {
  scenarios: {
    carga_cpu: {
      executor: 'ramping-vus',
      exec: 'cargaCpu',
      startVUs: 0,
      stages: [
        { duration: RAMP, target: VUS },
        { duration: HOLD, target: VUS },
        { duration: DOWN, target: 0 }
      ],
      gracefulRampDown: '40s'
    },
    navegacao: {
      executor: 'constant-vus',
      exec: 'navegacao',
      vus: 3,
      duration: TOTAL
    }
  },
  thresholds: {
    // O site precisa continuar respondendo para quem navega, mesmo sob carga
    'http_req_failed{scenario:navegacao}': ['rate<0.05'],
    'http_req_duration{scenario:navegacao}': ['p(95)<3000']
  }
};

export function setup() {
  const res = http.post(`${BASE_URL}/auth/admin`, JSON.stringify({ password: ADMIN_PASSWORD }), {
    headers: { 'Content-Type': 'application/json' }
  });
  if (res.status !== 200) {
    throw new Error(`Login de admin falhou (HTTP ${res.status}). Confira BASE_URL e ADMIN_PASSWORD.`);
  }
  return { token: res.json('token') };
}

export function cargaCpu(data) {
  const res = http.get(`${BASE_URL}/stress?duration=${STRESS_MS}`, {
    headers: { Authorization: `Bearer ${data.token}` },
    tags: { name: 'GET /stress' },
    timeout: '60s'
  });
  const ok = check(res, { 'stress respondeu 200': (r) => r.status === 200 });
  if (!ok) sleep(1); // instância trocando / ALB sem destino: espera um pouco
}

export function navegacao() {
  const events = http.get(`${BASE_URL}/events`, { tags: { name: 'GET /events' } });
  check(events, { 'vitrine respondeu 200': (r) => r.status === 200 });
  sleep(2);
}

export function handleSummary(data) {
  const m = data.metrics;
  const fmt = (v) => (v === undefined ? '-' : Math.round(v));
  const lines = [
    '',
    '================ RESUMO DO TESTE DE ELASTICIDADE ================',
    `Alvo: ${BASE_URL}`,
    `Requisições totais: ${fmt(m.http_reqs?.values.count)} (${(m.http_reqs?.values.rate || 0).toFixed(1)}/s)`,
    `Falhas HTTP: ${((m.http_req_failed?.values.rate || 0) * 100).toFixed(1)}%`,
    `Tempo de resposta da vitrine (p95): ${fmt(m['http_req_duration{scenario:navegacao}']?.values['p(95)'])} ms`,
    `Verificações aprovadas: ${fmt(m.checks?.values.passes)} de ${fmt((m.checks?.values.passes || 0) + (m.checks?.values.fails || 0))}`,
    'Veja no relatório HTML (K6_WEB_DASHBOARD_EXPORT) os gráficos de requisições, latência e usuários virtuais,',
    'e no dashboard do CloudWatch a CPU do grupo e o número de instâncias.',
    '=================================================================',
    ''
  ];
  return { stdout: lines.join('\n'), 'resumo-k6.json': JSON.stringify(data, null, 2) };
}
