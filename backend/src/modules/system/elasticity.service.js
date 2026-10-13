// Estado da elasticidade lido da AWS, para a tela de teste de carga do admin:
// instâncias do Auto Scaling Group, alarmes de CPU, CPU média recente e atividades de escala.
// Só funciona na AWS (PROJECT_NAME definido pelo Terraform); em desenvolvimento devolve available=false.
const { AutoScalingClient, DescribeAutoScalingGroupsCommand, DescribeScalingActivitiesCommand } = require('@aws-sdk/client-auto-scaling');
const { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand } = require('@aws-sdk/client-cloudwatch');
const { AWS_REGION } = require('../../config');

const PROJECT = process.env.PROJECT_NAME;
const autoscaling = PROJECT ? new AutoScalingClient({ region: AWS_REGION }) : null;
const cloudwatch = PROJECT ? new CloudWatchClient({ region: AWS_REGION }) : null;

const CACHE_MS = 4000; // várias abas/consultas seguidas reaproveitam a mesma leitura
let cache = { at: 0, data: null };

async function findGroup() {
  // O nome do grupo tem sufixo aleatório (name_prefix do Terraform): procura pelo prefixo do projeto
  let token;
  do {
    const page = await autoscaling.send(new DescribeAutoScalingGroupsCommand({ NextToken: token }));
    const group = (page.AutoScalingGroups || []).find((g) => g.AutoScalingGroupName.startsWith(`${PROJECT}-asg-`));
    if (group) return group;
    token = page.NextToken;
  } while (token);
  return null;
}

function series(result, id) {
  const r = (result.MetricDataResults || []).find((m) => m.Id === id);
  if (!r) return [];
  return r.Timestamps.map((t, i) => ({ t: new Date(t).toISOString(), v: Math.round(r.Values[i] * 10) / 10 }))
    .sort((a, b) => a.t.localeCompare(b.t));
}

async function read() {
  const group = await findGroup();
  if (!group) return { available: false, reason: 'Auto Scaling Group não encontrado.' };
  const name = group.AutoScalingGroupName;
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 60 * 1000);

  const [alarms, metrics, activities] = await Promise.all([
    cloudwatch.send(new DescribeAlarmsCommand({ AlarmNamePrefix: `${PROJECT}-cpu-` })),
    cloudwatch.send(new GetMetricDataCommand({
      StartTime: start,
      EndTime: end,
      ScanBy: 'TimestampAscending',
      MetricDataQueries: [
        {
          Id: 'cpu',
          MetricStat: {
            Metric: { Namespace: 'AWS/EC2', MetricName: 'CPUUtilization', Dimensions: [{ Name: 'AutoScalingGroupName', Value: name }] },
            Period: 60,
            Stat: 'Average'
          }
        },
        {
          Id: 'inservice',
          MetricStat: {
            Metric: { Namespace: 'AWS/AutoScaling', MetricName: 'GroupInServiceInstances', Dimensions: [{ Name: 'AutoScalingGroupName', Value: name }] },
            Period: 60,
            Stat: 'Maximum'
          }
        }
      ]
    })),
    autoscaling.send(new DescribeScalingActivitiesCommand({ AutoScalingGroupName: name, MaxRecords: 10 }))
  ]);

  return {
    available: true,
    group: {
      name,
      min: group.MinSize,
      max: group.MaxSize,
      desired: group.DesiredCapacity,
      inService: (group.Instances || []).filter((i) => i.LifecycleState === 'InService').length,
      instances: (group.Instances || []).map((i) => ({
        id: i.InstanceId,
        state: i.LifecycleState,
        health: i.HealthStatus,
        zone: i.AvailabilityZone
      }))
    },
    alarms: (alarms.MetricAlarms || []).map((a) => ({
      name: a.AlarmName,
      state: a.StateValue,
      threshold: a.Threshold,
      operator: a.ComparisonOperator,
      updatedAt: a.StateUpdatedTimestamp
    })),
    cpu: series(metrics, 'cpu'),
    inServiceHistory: series(metrics, 'inservice'),
    activities: (activities.Activities || []).map((a) => ({
      time: a.StartTime,
      end: a.EndTime || null,
      status: a.StatusCode,
      description: a.Description,
      cause: a.Cause
    }))
  };
}

async function getElasticityStatus() {
  if (!autoscaling) return { available: false, reason: 'Disponível apenas na AWS (Auto Scaling).' };
  if (cache.data && Date.now() - cache.at < CACHE_MS) return cache.data;
  const data = await read();
  cache = { at: Date.now(), data };
  return data;
}

module.exports = { getElasticityStatus };
