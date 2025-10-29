import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { google } from 'googleapis';
import swaggerUi from 'swagger-ui-express';
import swaggerJsdoc from 'swagger-jsdoc';
import axios from 'axios';

dotenv.config();
const app = express();
app.use(bodyParser.json());

// ⚡️ Configurar OAuth2 con refresh token de .env
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

const endpoint = process.env.ENDPOINT_POSTGRES;
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// 🧠 Swagger Config
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Google Calendar Webhook API',
      version: '1.0.0',
      description: 'Webhook para recibir cambios en Google Calendar.',
    },
    servers: [{ url: `http://localhost:${process.env.PORT || 3000}` }],
  },
  apis: ['./server.js'],
};
const swaggerDocs = swaggerJsdoc(swaggerOptions);
app.use('/api-calendar', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

/**
 * @openapi
 * /webhook/google-calendar:
 *   post:
 *     summary: Recibe notificaciones del webhook de Google Calendar
 *     description: Endpoint que Google llama cuando hay un cambio en el calendario.
 *     tags:
 *       - Webhook
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             example: {}
 *     responses:
 *       200:
 *         description: Notificación procesada correctamente con eventos actualizados
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 updatedEvents:
 *                   type: array
 *                   items:
 *                     type: object
 *       500:
 *         description: Error procesando la notificación
 */
app.post('/webhook/google-calendar', async (req, res) => {
  console.log('📩 Notificación recibida de Google Calendar:', req.headers);

  try {
    const accessToken = await oauth2Client.getAccessToken();
    oauth2Client.setCredentials({ access_token: accessToken.token });

    let lastSyncToken = null;
    try {
      const tokenRes = await axios.post(endpoint, { query: 'SELECT * FROM google_sync_tokens LIMIT 1;' });
      const rows = tokenRes.data.rows;
      if (rows.length > 0) lastSyncToken = rows[0].sync_token;
    } catch (err) {
      console.error('❌ Error obteniendo sync_token desde la API:', err.message);
    }

    let params = lastSyncToken
      ? { calendarId: 'primary', syncToken: lastSyncToken, singleEvents: true }
      : { calendarId: 'primary', showDeleted: true, singleEvents: true, orderBy: 'updated' };

    let response;
    try {
      response = await calendar.events.list(params);
    } catch (err) {
      if (err.code === 410 || err.code === 401) {
        console.log('🔁 syncToken expirado o inválido, haciendo full sync');
        response = await calendar.events.list({ calendarId: 'primary', showDeleted: true, singleEvents: true, orderBy: 'updated' });
      } else throw err;
    }

    const updatedEvents = response.data.items || [];
    const swaggerResponse = updatedEvents.length > 0
      ? { message: `Se actualizaron ${updatedEvents.length} evento(s)`, updatedEvents }
      : { message: 'No hay eventos actualizados', updatedEvents: [] };

    // 🔹 Actualizar sync_token usando la variable ENDPOINT_POSTGRES
    if (response.data.nextSyncToken) {
      const safeToken = response.data.nextSyncToken.replace(/'/g, "''");
      try {
        await axios.post(endpoint, {
          query: `INSERT INTO google_sync_tokens (id, sync_token) 
                  VALUES ('id_token', '${safeToken}')
                  ON CONFLICT (id)
                  DO UPDATE SET sync_token = EXCLUDED.sync_token;`
        });
        console.log('🔁 SyncToken actualizado vía API externa');
      } catch (err) {
        console.error('❌ Error actualizando sync_token vía API:', err.message);
      }
    }

    // Enviar JSON a tu endpoint externo definido en .env
    try {
      await axios.post(process.env.EXTERNAL_ENDPOINT_URL, swaggerResponse, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 10000,
      });
      console.log(`✅ JSON enviado a ${process.env.EXTERNAL_ENDPOINT_URL}`);
    } catch (err) {
      console.error('❌ Error enviando JSON al endpoint externo:', err.message);
    }

    res.status(200).json(swaggerResponse);
  } catch (error) {
    console.error('❌ Error procesando la notificación:', error);
    res.status(500).json({ error: 'Error procesando la notificación', details: error.message });
  }
});


// ⚡ Crear canal de notificaciones al iniciar
const createWatchChannel = async () => {
  try {
    const uniqueId = 'canal-' + Date.now(); // Genera un ID único
    const res = await calendar.events.watch({
      calendarId: 'primary',
      requestBody: {
        id: uniqueId,
        type: 'web_hook',
        address: process.env.WEBHOOK_URL,
        token: 'opcional-token'
      }
    });
    console.log('📡 Canal de notificaciones creado en:', process.env.WEBHOOK_URL);
    console.log('Datos del canal:', res.data);
  } catch (err) {
    console.error('❌ Error creando canal de notificaciones:', err.message);
  }
};

// 🧱 Inicializar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  console.log(`📘 Swagger UI disponible en: http://localhost:${PORT}/api-calendar`);
  await createWatchChannel(); // Crear canal al iniciar
});
