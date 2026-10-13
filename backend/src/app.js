const express = require('express');
const cors = require('cors');
const { FRONTEND_DIR, UPLOADS_DIR } = require('./config');
const errorHandler = require('./middlewares/errorHandler');

const systemRoutes = require('./modules/system/system.routes');
const eventRoutes = require('./modules/events/event.routes');
const orderRoutes = require('./modules/orders/order.routes');
const userRoutes = require('./modules/users/user.routes');
const authRoutes = require('./modules/auth/auth.routes');
const auditRoutes = require('./modules/audit/audit.routes');
const reservationRoutes = require('./modules/reservations/reservation.routes');
const ticketRoutes = require('./modules/tickets/ticket.routes');
const meRoutes = require('./modules/users/me.routes');

const app = express();

// O server.js troca esta promessa pela da inicialização (schema do RDS, Redis).
app.locals.ready = Promise.resolve();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Nenhuma rota de dados atende antes do schema do RDS estar pronto (o /health responde sempre,
// para o ALB não derrubar a instância enquanto ela inicializa).
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  return app.locals.ready.then(
    () => next(),
    () => res.status(503).json({ message: 'Serviço indisponível: banco de dados não inicializado.' })
  );
});

app.use(systemRoutes); // /health, /stress
app.use('/events', eventRoutes); // CRUD de jogos
app.use('/orders', orderRoutes); // compra e listagem de pedidos
app.use('/auth', userRoutes); // /auth/register, /auth/login
app.use('/auth', authRoutes); // /auth/admin
app.use('/audit-logs', auditRoutes); // auditoria (DynamoDB)
app.use('/reservations', reservationRoutes); // reserva temporária do checkout
app.use('/tickets', ticketRoutes); // download do PDF pelo link do e-mail
app.use('/users/me', meRoutes); // preferências do cliente logado (e-mail)

app.use(errorHandler);

module.exports = app;
