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

// ⚙️ Arrays para guardar los webhooks recibidos
const allWebhooks = [];
const currentChannelWebhooks = [];

// ⚡️ Configurar OAuth2 con refresh token
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

// 🔐 Canal válido
let VALID_CHANNEL_ID = process.env.VALID_CHANNEL_ID || null;

// Cargar canal desde DB si no existe
const loadChannelFromDB = async () => {
  try {
    const res = await axios.post(endpoint, {
      query: "SELECT id FROM google_channels WHERE active = true LIMIT 1;"
    });

    if (res.data.rows?.length > 0) {
      VALID_CHANNEL_ID = res.data.rows[0].id;
      console.log('✅ Canal válido cargado desde la base de datos:', VALID_CHANNEL_ID);
    } else {
      console.warn('⚠️ No se encontró canal activo en la base de datos.');
    }
  } catch (err) {
    console.error('❌ Error obteniendo canal desde la base de datos:', err.message);
  }
};

app.post('/webhook/google-calendar', async (req, res) => {
  const incomingChannelId = req.headers['x-goog-channel-id'];
  const resourceId = req.headers['x-goog-resource-id'];

  // 🧾 Registrar todos los webhooks recibidos
  allWebhooks.push({
    timestamp: new Date().toISOString(),
    channelId: incomingChannelId,
    resourceId: resourceId || null,
  });

  console.log('📩 Webhook recibido:', { incomingChannelId, resourceId });

  try {
    // 🔎 Consultar canal activo desde la base de datos
    const dbRes = await axios.post(endpoint, {
      query: "SELECT id FROM google_channels WHERE active = true LIMIT 1;",
    });

    const activeChannelId = dbRes.data.rows?.[0]?.id || null;

    if (!activeChannelId) {
      console.warn('⚠️ No hay canal activo en la base de datos.');
      return res.status(200).send('Sin canal activo en DB');
    }

    // 🔍 Comparar canales
    if (incomingChannelId !== activeChannelId) {
      console.log('🚫 El nombre del canal no coincide con el de la base de datos');
      console.log(`📤 Canal recibido: ${incomingChannelId}`);
      console.log(`📦 Canal activo en DB: ${activeChannelId}`);
      return res.status(200).send('Canal no coincide');
    }

    // ✅ Si coincide, continuar con la lógica
    console.log('✅ El canal coincide con el de la base de datos');
    console.log(`🎯 Canal válido: ${activeChannelId}`);

    // Registrar en array de válidos
    currentChannelWebhooks.push({
      timestamp: new Date().toISOString(),
      channelId: incomingChannelId,
      resourceId: resourceId || null,
    });

    const accessToken = await oauth2Client.getAccessToken();
    oauth2Client.setCredentials({ access_token: accessToken.token });

    // 🔁 Obtener sync_token
    let lastSyncToken = null;
    try {
      const tokenRes = await axios.post(endpoint, {
        query: 'SELECT sync_token FROM google_sync_tokens LIMIT 1;',
      });
      const rows = tokenRes.data.rows;
      if (rows.length > 0) lastSyncToken = rows[0].sync_token;
    } catch (err) {
      console.error('❌ Error obteniendo sync_token:', err.message);
    }

    // 📅 Obtener eventos actualizados
    let params = lastSyncToken
      ? { calendarId: 'primary', syncToken: lastSyncToken, singleEvents: true }
      : { calendarId: 'primary', showDeleted: true, singleEvents: true, orderBy: 'updated' };

    let response;
    try {
      response = await calendar.events.list(params);
    } catch (err) {
      if (err.code === 410 || err.code === 401) {
        console.log('🔁 syncToken expirado, haciendo full sync');
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

    // 🌐 Enviar eventos actualizados a una URL externa (si hay eventos nuevos)
    if (updatedEvents.length > 0) {
      try {
        const externalUrl = process.env.ENDPOINT_ORQUESTADOR; // define esto en tu .env
        console.log(`📤 Enviando ${updatedEvents.length} evento(s) a: ${externalUrl}`);

        const responsePost = await axios.post(externalUrl, {
          events: updatedEvents,
          channelId: incomingChannelId,
          timestamp: new Date().toISOString(),
        });

        console.log('✅ Eventos enviados correctamente:', responsePost.status);
      } catch (err) {
        console.error('❌ Error enviando eventos al endpoint externo:', err.message);
      }
    } else {
      console.log('ℹ️ No hay eventos nuevos para enviar.');
    }

    
    // 💾 Guardar nuevo sync_token
    if (response.data.nextSyncToken) {
      const safeToken = response.data.nextSyncToken.replace(/'/g, "''");
      await axios.post(endpoint, {
        query: `INSERT INTO google_sync_tokens (id, sync_token)
                VALUES ('id_token', '${safeToken}')
                ON CONFLICT (id)
                DO UPDATE SET sync_token = EXCLUDED.sync_token;`,
      });
      console.log('🔁 SyncToken actualizado');
    }

    return res.status(200).json(swaggerResponse);
  } catch (error) {
    console.error('❌ Error procesando webhook:', error.message);
    return res.status(500).json({ error: 'Error procesando webhook', details: error.message });
  }
});


// 🧱 Inicializar servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🚀 Servidor escuchando en el puerto ${PORT}`);
  console.log(`📘 Swagger UI: http://localhost:${PORT}/api-calendar`);

  if (!VALID_CHANNEL_ID) {
    await loadChannelFromDB();
  } else {
    console.log('✅ Canal válido cargado desde .env:', VALID_CHANNEL_ID);
  }
});
