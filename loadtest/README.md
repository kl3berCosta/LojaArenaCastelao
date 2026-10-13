# Teste de carga com k6 (Parte 2 — elasticidade)

O script `k6-elasticidade.js` gera carga de CPU nas instâncias pelo Load Balancer até o Auto Scaling
criar novas instâncias, e produz um **relatório HTML com gráficos** (requisições por segundo, tempo de
resposta, usuários virtuais) para mostrar no vídeo.

## Instalar o k6

```bash
# Ubuntu (pacote oficial)
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
  --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
  | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update && sudo apt-get install k6
```

Ou baixe o binário em https://github.com/grafana/k6/releases.

## Rodar

```bash
cd loadtest
BASE_URL=http://<seu-alb>.us-east-1.elb.amazonaws.com \
ADMIN_PASSWORD='sua-senha-de-admin' \
K6_WEB_DASHBOARD=true \
K6_WEB_DASHBOARD_EXPORT=relatorio-k6.html \
k6 run k6-elasticidade.js
```

- `BASE_URL`: a `application_url` do `terraform output`.
- `ADMIN_PASSWORD`: a mesma do `terraform.tfvars` (a rota `/stress` é só do administrador).
- `K6_WEB_DASHBOARD=true`: abre um **painel ao vivo** em http://localhost:5665 (bom para gravar).
- `K6_WEB_DASHBOARD_EXPORT`: salva o relatório final com os gráficos em `relatorio-k6.html`.

Parâmetros opcionais (variáveis de ambiente):

| Variável | Padrão | O que faz |
| :--- | :--- | :--- |
| `VUS` | 12 | Usuários virtuais gerando carga de CPU |
| `RAMP` | 1m | Tempo de subida da carga |
| `HOLD` | 6m | Tempo com a carga máxima (dá tempo do alarme disparar e da 2ª/3ª instância subir) |
| `DOWN` | 30s | Tempo de descida |
| `STRESS_MS` | 4000 | Duração de cada requisição `/stress` (máx. 30000) |

Dois cenários rodam juntos: **carga_cpu** (chama `/stress`, que ocupa todas as vCPUs da instância) e
**navegacao** (3 torcedores consultando a vitrine). Os limites (*thresholds*) exigem que a vitrine
continue respondendo durante a carga: menos de 5% de falhas e p95 abaixo de 3 s.

## O que mostrar no vídeo

1. O painel do k6 (http://localhost:5665) com as requisições subindo.
2. O **dashboard do CloudWatch** (`terraform output cloudwatch_dashboard_url`): a CPU passa da linha de
   70%, o alarme vai para ALARM e o gráfico de instâncias sobe de 1 para 2 (ou 3).
3. No painel admin (`/admin.html` → Infraestrutura → **Monitorar**): novos hostnames respondendo.
4. Após o fim do teste: CPU abaixo de 25% e o grupo voltando a 1 instância.
5. O `relatorio-k6.html` gerado, com os gráficos do teste completo.
