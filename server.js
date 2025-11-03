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

// 🔐 Canal válido (se toma de .env o DB)
let VALID_CHANNEL_ID = process.env.VALID_CHANNEL_ID || null;

// Si no está definido en .env, lo intentamos obtener desde la base de datos
const loadChannelFromDB = async () => {
  try {
    const res = await axios.post(endpoint, {
      query: "SELECT channel_id FROM google_channels WHERE id = 'current';",
    });
    if (res.data.rows?.length > 0) {
      VALID_CHANNEL_ID = res.data.rows[0].channel_id;
      console.log('✅ Canal válido cargado desde la base de datos:', VALID_CHANNEL_ID);
    } else {
      console.warn('⚠️ No se encontró canal en la base de datos. Ejecuta create_channel.js para generarlo.');
    }
  } catch (err) {
    console.error('❌ Error obteniendo canal desde la base de datos:', err.message);
  }
};

/**
 * @openapi
 * /webhook/google-calendar:
 *   post:
 *     summary: Recibe notificaciones del webhook de Google Calendar
 *     description: Endpoint que Google llama cuando hay un cambio en el calendario.
 *     tags:
 *       - Webhook
 *     parameters:
 *       - in: header
 *         name: X-Goog-Channel-ID
 *         schema:
 *           type: string
 *         required: true
 *         description: ID del canal configurado en Google Calendar (debe coincidir con el .env)
 *       - in: header
 *         name: X-Goog-Resource-ID
 *         schema:
 *           type: string
 *         required: false
 *         description: ID del recurso enviado por Google
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
 *       403:
 *         description: Canal no válido
 *       500:
 *         description: Error procesando la notificación
 */

app.post('/webhook/google-calendar', async (req, res) => {
  console.log('📩 Notificación recibida de Google Calendar:', req.headers);

  // ✅ Verificar canal válido
  const incomingChannelId = req.headers['x-goog-channel-id'];
  if (incomingChannelId !== VALID_CHANNEL_ID) {
    console.warn('⚠️ Canal no válido, ignorando notificación');
    return res.status(403).json({ error: 'Canal no válido' });
  }

  try {
    const accessToken = await oauth2Client.getAccessToken();
    oauth2Client.setCredentials({ access_token: accessToken.token });

    // Obtener último sync_token
    let lastSyncToken = null;
    try {
      const tokenRes = await axios.post(endpoint, {
        query: 'SELECT * FROM google_sync_tokens LIMIT 1;',
      });
      const rows = tokenRes.data.rows;
      if (rows.length > 0) lastSyncToken = rows[0].sync_token;
    } catch (err) {
      console.error('❌ Error obteniendo sync_token desde la API:', err.message);
    }

    // Obtener eventos actualizados
    let params = lastSyncToken
      ? { calendarId: 'primary', syncToken: lastSyncToken, singleEvents: true }
      : { calendarId: 'primary', showDeleted: true, singleEvents: true, orderBy: 'updated' };

    let response;
    try {
      response = await calendar.events.list(params);
    } catch (err) {
      if (err.code === 410 || err.code === 401) {
        console.log('🔁 syncToken expirado o inválido, haciendo full sync');
        response = await calendar.events.list({
          calendarId: 'primary',
          showDeleted: true,
          singleEvents: true,
          orderBy: 'updated',
        });
      } else throw err;
    }

    const updatedEvents = response.data.items || [];
    const swaggerResponse =
      updatedEvents.length > 0
        ? { message: `Se actualizaron ${updatedEvents.length} evento(s)`, updatedEvents }
        : { message: 'No hay eventos actualizados', updatedEvents: [] };

    // Actualizar sync_token
    if (response.data.nextSyncToken) {
      const safeToken = response.data.nextSyncToken.replace(/'/g, "''");
      try {
        await axios.post(endpoint, {
          query: `INSERT INTO google_sync_tokens (id, sync_token)
                  VALUES ('id_token', '${safeToken}')
                  ON CONFLICT (id)
                  DO UPDATE SET sync_token = EXCLUDED.sync_token;`,
        });
        console.log('🔁 SyncToken actualizado vía API externa');
      } catch (err) {
        console.error('❌ Error actualizando sync_token vía API:', err.message);
      }
    }

    // Enviar JSON a endpoint externo
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

// 🧱 Inicializar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  console.log(`📘 Swagger UI disponible en: http://localhost:${PORT}/api-calendar`);

  if (!VALID_CHANNEL_ID) {
    await loadChannelFromDB();
  } else {
    console.log('✅ Canal válido cargado desde .env:', VALID_CHANNEL_ID);
  }
});
